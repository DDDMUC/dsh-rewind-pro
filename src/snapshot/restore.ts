// Restore: put the workspace back the way it was at a checkpoint.
//
// Three properties matter and are all covered by tests:
//   * idempotent  — compare against disk by hash; a second run changes nothing
//   * rescue-first — anything that differs is moved aside, never deleted
//   * crash-safe  — every step is journaled before it runs, so an interrupted
//                   restore can be finished on the next start

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from './guard.js'
import { closeJournal, journalFile, openJournal, appendStep, readJournal } from './journal.js'
import type { Journal } from './journal.js'
import { moveToRescue } from './rescue.js'
import type { RescueIo } from './rescue.js'
import type { SnapshotStore } from './store.js'

export interface RestoreRequest {
  sessionId: string
  anchorKey: string
  root: string
  restoreId: string
  maxFileBytes: number
  /** Files created after the checkpoint; they are rescued, not kept. */
  extraFiles?: string[]
  io?: RescueIo
  now?: () => number
}

export interface RestoreReport {
  restored: string[]
  recreated: string[]
  rescued: string[]
  unchanged: string[]
  skipped: string[]
  journalPath: string
  rescueDir: string
}

// A fresh report every time: sharing array references across calls would make
// one restore's results leak into the next one's.
const emptyReport = (journalPath: string, rescueDir: string): RestoreReport => ({
  restored: [],
  recreated: [],
  rescued: [],
  unchanged: [],
  skipped: [],
  journalPath,
  rescueDir,
})

const toAbs = (root: string, rel: string): string => path.join(root, rel.split('/').join(path.sep))

async function writeAtomic(abs: string, data: Buffer): Promise<void> {
  const tmp = `${abs}.${process.pid}.tmp`
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(tmp, data)
  await rename(tmp, abs)
}

export function planJournalPath(store: SnapshotStore, request: RestoreRequest): string {
  return journalFile(path.join(store.root, 'sessions', request.sessionId), request.restoreId)
}

/** Journal every intended step without touching the workspace (crash rehearsal). */
export async function planRestore(store: SnapshotStore, request: RestoreRequest): Promise<Journal> {
  const file = planJournalPath(store, request)
  const anchor = await store.readAnchor(request.sessionId, request.anchorKey)
  if (!anchor) return readJournal(file)
  await openJournal(file, {
    restoreId: request.restoreId,
    sessionId: request.sessionId,
    anchorKey: request.anchorKey,
    startedAt: (request.now ?? Date.now)(),
  })
  for (const entry of anchor.files) {
    await appendStep(file, { path: entry.path, action: 'restore', status: 'planned', sha256: entry.sha256, time: (request.now ?? Date.now)() })
  }
  for (const rel of request.extraFiles ?? []) {
    await appendStep(file, { path: rel, action: 'rescue', status: 'planned', time: (request.now ?? Date.now)() })
  }
  return readJournal(file)
}

export async function restoreAnchor(store: SnapshotStore, request: RestoreRequest): Promise<RestoreReport> {
  const anchor = await store.readAnchor(request.sessionId, request.anchorKey)
  const rescueDir = store.rescueDir(request.sessionId, request.restoreId)
  const journalPath = planJournalPath(store, request)
  if (!anchor) return emptyReport(journalPath, rescueDir)

  const report: RestoreReport = emptyReport(journalPath, rescueDir)
  const now = request.now ?? Date.now

  // A previous crash left an open journal: adopt it instead of starting over.
  const existing = await readJournal(journalPath)
  if (!existing.closed && existing.restoreId === request.restoreId && existing.steps.length > 0) {
    await openJournal(journalPath, {
      restoreId: request.restoreId,
      sessionId: request.sessionId,
      anchorKey: request.anchorKey,
      startedAt: existing.startedAt || now(),
    })
  } else {
    await openJournal(journalPath, {
      restoreId: request.restoreId,
      sessionId: request.sessionId,
      anchorKey: request.anchorKey,
      startedAt: now(),
    })
  }

  for (const entry of anchor.files) {
    const abs = toAbs(request.root, entry.path)
    let data: Buffer
    try {
      data = await store.readBlob(request.sessionId, entry.sha256)
    } catch {
      report.skipped.push(entry.path)
      await appendStep(journalPath, { path: entry.path, action: 'skip', status: 'failed', detail: 'blob missing', time: now() })
      continue
    }

    let onDisk: Buffer | null = null
    try {
      onDisk = await readFile(abs)
    } catch {
      onDisk = null
    }

    if (onDisk && sha256(onDisk) === entry.sha256) {
      report.unchanged.push(entry.path)
      await appendStep(journalPath, { path: entry.path, action: 'skip', status: 'done', sha256: entry.sha256, time: now() })
      continue
    }

    if (onDisk) {
      if (onDisk.byteLength > request.maxFileBytes) {
        report.skipped.push(entry.path)
        await appendStep(journalPath, { path: entry.path, action: 'restore', status: 'failed', detail: 'too-large', time: now() })
        continue
      }
      const moved = await moveToRescue(abs, rescueDir, {
        maxFileBytes: request.maxFileBytes,
        relative: entry.path,
        ...(request.io ? { io: request.io } : {}),
      })
      if (!moved.ok) {
        report.skipped.push(entry.path)
        await appendStep(journalPath, { path: entry.path, action: 'restore', status: 'failed', detail: moved.reason, time: now() })
        continue
      }
      report.rescued.push(entry.path)
      await appendStep(journalPath, { path: entry.path, action: 'rescue', status: 'done', rescuePath: moved.target, time: now() })
    }

    await writeAtomic(abs, data)
    if (onDisk) report.restored.push(entry.path)
    else report.recreated.push(entry.path)
    await appendStep(journalPath, {
      path: entry.path,
      action: onDisk ? 'restore' : 'recreate',
      status: 'done',
      sha256: entry.sha256,
      time: now(),
    })
  }

  for (const rel of request.extraFiles ?? []) {
    const abs = toAbs(request.root, rel)
    const moved = await moveToRescue(abs, rescueDir, {
      maxFileBytes: request.maxFileBytes,
      relative: rel,
      ...(request.io ? { io: request.io } : {}),
    })
    if (moved.ok) {
      report.rescued.push(rel)
      await appendStep(journalPath, { path: rel, action: 'rescue', status: 'done', rescuePath: moved.target, time: now() })
    } else if (moved.reason !== 'missing') {
      report.skipped.push(rel)
      await appendStep(journalPath, { path: rel, action: 'rescue', status: 'failed', detail: moved.reason, time: now() })
    }
  }

  await closeJournal(journalPath)
  return report
}

/**
 * Finish a restore that was interrupted. Returns null when there is nothing to
 * resume. Steps are idempotent (hash compare), so replaying them is safe.
 */
export async function resumeRestore(store: SnapshotStore, request: RestoreRequest): Promise<RestoreReport | null> {
  const journalPath = planJournalPath(store, request)
  const journal = await readJournal(journalPath)
  if (journal.closed || journal.restoreId !== request.restoreId) return null
  return restoreAnchor(store, request)
}

/** Drop a finished journal once the restore is confirmed complete. */
export async function discardJournal(store: SnapshotStore, request: RestoreRequest): Promise<void> {
  await rm(planJournalPath(store, request), { force: true })
}

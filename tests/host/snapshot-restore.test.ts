// Restore: idempotent, rescue-first, crash-recoverable.
//
// Running the same restore twice must be a no-op the second time (hash compare
// against disk). Anything that differs is moved to rescue instead of deleted,
// so a wrong rewind is never data loss. Every step is journaled first, so a
// crash mid-restore can be finished on the next start.

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureBeforeWrite } from '../../src/snapshot/capture'
import { readJournal } from '../../src/snapshot/journal'
import { restoreAnchor, resumeRestore } from '../../src/snapshot/restore'
import { createSnapshotStore } from '../../src/snapshot/store'
import { cleanupTmp, tmpDir, writeFile as putFile } from './helpers/tmp'

afterAll(cleanupTmp)

const base = { sessionId: 's1', anchorKey: 'turn-4', maxFileBytes: 1024 * 1024 }

async function seeded() {
  const root = await tmpDir('restore-')
  const store = createSnapshotStore(path.join(root, '.snapshots'))
  const abs = await putFile(root, 'src/a.ts', 'original')
  await captureBeforeWrite(store, { ...base, root, absPath: abs })
  return { root, store, abs }
}

describe('restoreAnchor', () => {
  it('puts the original content back', async () => {
    const { root, store, abs } = await seeded()
    await writeFile(abs, 'changed', 'utf8')

    const report = await restoreAnchor(store, {
      sessionId: 's1',
      anchorKey: 'turn-4',
      root,
      restoreId: 'r1',
      maxFileBytes: 1024 * 1024,
    })

    expect(report.restored).toEqual(['src/a.ts'])
    expect(await readFile(abs, 'utf8')).toBe('original')
  })

  it('is idempotent: a second run restores nothing', async () => {
    const { root, store, abs } = await seeded()
    await writeFile(abs, 'changed', 'utf8')
    const request = { sessionId: 's1', anchorKey: 'turn-4', root, restoreId: 'r1', maxFileBytes: 1024 * 1024 }

    await restoreAnchor(store, request)
    const second = await restoreAnchor(store, { ...request, restoreId: 'r2' })

    expect(second.restored).toEqual([])
    expect(second.unchanged).toEqual(['src/a.ts'])
    expect(await readFile(abs, 'utf8')).toBe('original')
  })

  it('rescues a divergent file instead of deleting it', async () => {
    const { root, store, abs } = await seeded()
    await writeFile(abs, 'diverged', 'utf8')

    const report = await restoreAnchor(store, {
      sessionId: 's1',
      anchorKey: 'turn-4',
      root,
      restoreId: 'r1',
      maxFileBytes: 1024 * 1024,
    })

    expect(report.restored).toEqual(['src/a.ts'])
    expect(report.rescued).toHaveLength(1)
    const rescued = await readFile(path.join(report.rescueDir!, report.rescued[0]), 'utf8')
    expect(rescued).toBe('diverged')
  })

  it('recreates a file that was deleted after the checkpoint', async () => {
    const { root, store, abs } = await seeded()
    await rm(abs)

    const report = await restoreAnchor(store, {
      sessionId: 's1',
      anchorKey: 'turn-4',
      root,
      restoreId: 'r1',
      maxFileBytes: 1024 * 1024,
    })

    expect(report.recreated).toEqual(['src/a.ts'])
    expect(await readFile(abs, 'utf8')).toBe('original')
  })

  it('rescues files that did not exist at the checkpoint', async () => {
    const { root, store } = await seeded()
    await putFile(root, 'src/new.ts', 'created later')

    const report = await restoreAnchor(store, {
      sessionId: 's1',
      anchorKey: 'turn-4',
      root,
      restoreId: 'r1',
      maxFileBytes: 1024 * 1024,
      extraFiles: ['src/new.ts'],
    })

    expect(report.rescued).toEqual(['src/new.ts'])
    expect(report.rescueDir).toBeTruthy()
  })

  it('journals every step so an interrupted restore can be finished', async () => {
    const { root, store, abs } = await seeded()
    await writeFile(abs, 'changed', 'utf8')

    const report = await restoreAnchor(store, {
      sessionId: 's1',
      anchorKey: 'turn-4',
      root,
      restoreId: 'r-crash',
      maxFileBytes: 1024 * 1024,
    })

    const journal = await readJournal(report.journalPath)
    expect(journal.restoreId).toBe('r-crash')
    expect(journal.steps.some((step) => step.path === 'src/a.ts' && step.status === 'done')).toBe(true)
    expect(journal.closed).toBe(true)
  })

  it('resumeRestore finishes a restore that crashed halfway', async () => {
    const { root, store, abs } = await seeded()
    await writeFile(abs, 'changed', 'utf8')

    // Simulate a crash: plan the steps, then die before doing any of them.
    const journal = await planOnly(store, {
      sessionId: 's1',
      anchorKey: 'turn-4',
      root,
      restoreId: 'r-half',
      maxFileBytes: 1024 * 1024,
    })
    expect(await readFile(abs, 'utf8')).toBe('changed')

    const report = await resumeRestore(store, {
      sessionId: 's1',
      anchorKey: 'turn-4',
      root,
      restoreId: 'r-half',
      maxFileBytes: 1024 * 1024,
    })

    expect(report).not.toBeNull()
    expect(journal.steps.length).toBeGreaterThan(0)
    expect(await readFile(abs, 'utf8')).toBe('original')
  })
})

/** Test helper in the "crash" role: write the journal, do no work. */
async function planOnly(store: ReturnType<typeof createSnapshotStore>, request: Parameters<typeof restoreAnchor>[1]) {
  const { planRestore } = await import('../../src/snapshot/restore')
  return planRestore(store, request)
}

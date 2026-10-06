// Crash-safe journal for restore operations.
//
// One JSONL file per restore: a header line, one line per step (planned, then
// done/failed), and a close line. Nothing is ever rewritten in place, and a
// restore is only considered complete when the close line is present — which is
// what makes "did we crash halfway?" answerable on the next start.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type JournalAction = 'restore' | 'recreate' | 'rescue' | 'skip'

export interface JournalStep {
  path: string
  action: JournalAction
  status: 'planned' | 'done' | 'failed'
  sha256?: string
  rescuePath?: string
  detail?: string
  time: number
}

export interface Journal {
  restoreId: string
  sessionId: string
  anchorKey: string
  startedAt: number
  closed: boolean
  steps: JournalStep[]
}

interface Header {
  type: 'header'
  restoreId: string
  sessionId: string
  anchorKey: string
  startedAt: number
}

type Line = Header | ({ type: 'step' } & JournalStep) | { type: 'close'; at: number }

export function journalFile(sessionRoot: string, restoreId: string): string {
  return path.join(sessionRoot, 'journals', `${restoreId}.jsonl`)
}

export async function openJournal(file: string, meta: Omit<Header, 'type'>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ type: 'header', ...meta })}\n`, 'utf8')
}

export async function appendStep(file: string, step: JournalStep): Promise<void> {
  await appendFile(file, `${JSON.stringify({ type: 'step', ...step })}\n`, 'utf8')
}

export async function closeJournal(file: string): Promise<void> {
  await appendFile(file, `${JSON.stringify({ type: 'close', at: Date.now() })}\n`, 'utf8')
}

export async function readJournal(file: string): Promise<Journal> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { restoreId: '', sessionId: '', anchorKey: '', startedAt: 0, closed: false, steps: [] }
  }

  const journal: Journal = { restoreId: '', sessionId: '', anchorKey: '', startedAt: 0, closed: false, steps: [] }
  const latest = new Map<string, JournalStep>()

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let parsed: Line
    try {
      parsed = JSON.parse(line) as Line
    } catch {
      // A torn last line is the crash signature: ignore it, the steps before
      // it are still authoritative.
      continue
    }
    if (parsed.type === 'header') {
      journal.restoreId = parsed.restoreId
      journal.sessionId = parsed.sessionId
      journal.anchorKey = parsed.anchorKey
      journal.startedAt = parsed.startedAt
    } else if (parsed.type === 'step') {
      const { type: _type, ...step } = parsed
      // Later lines win: planned then done for the same path.
      latest.set(`${step.path}:${step.action}`, step)
    } else {
      journal.closed = true
    }
  }

  journal.steps = [...latest.values()]
  return journal
}

/** Steps that were planned but never reported done — the crash resume list. */
export function pendingSteps(journal: Journal): JournalStep[] {
  return journal.steps.filter((step) => step.status === 'planned' || step.status === 'failed')
}

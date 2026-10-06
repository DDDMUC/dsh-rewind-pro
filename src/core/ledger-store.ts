// Ledger persistence: append-only JSON per session.
//
// Guarantees the rest of the plugin leans on:
//   * every write is atomic (tmp -> rename) so a crash never leaves half JSON
//   * version is strictly monotonic; remote states at or below local are dropped
//     (multi-tab echo suppression)
//   * appends to one session are serialized, so two tabs cannot interleave
//     read-modify-write and lose an op
//   * a corrupt file never breaks the session: it is moved aside and we start
//     from empty rather than throwing into the host

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LedgerOp, LedgerState } from './types.js'

const EMPTY: LedgerState = { version: 0, ops: [] }

/** Keep session ids inside the store directory — never trust them as paths. */
export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 120)
}

export interface LedgerStoreOptions {
  dir: string
  sessionId: string
}

export interface LedgerStore {
  read: () => Promise<LedgerState>
  append: (op: LedgerOp, originClientId?: string) => Promise<LedgerState>
  /** Adopt a remote state only when it is strictly newer and not our own echo. */
  mergeRemote: (remote: LedgerState, localClientId?: string) => Promise<LedgerState>
}

type Task<T> = () => Promise<T>

/** Serialize work per key so concurrent callers cannot clobber each other. */
function createSerialQueue(): <T>(key: string, task: Task<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, task: Task<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    tails.set(
      key,
      next.catch(() => undefined),
    )
    return next
  }
}

function parseState(raw: string): LedgerState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LedgerState>
    if (!parsed || typeof parsed.version !== 'number' || !Array.isArray(parsed.ops)) return null
    return { version: parsed.version, originClientId: parsed.originClientId, ops: parsed.ops as LedgerOp[] }
  } catch {
    return null
  }
}

export function createLedgerStore(options: LedgerStoreOptions): LedgerStore {
  const file = path.join(options.dir, `${sanitizeSessionId(options.sessionId)}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  const enqueue = createSerialQueue()
  const key = file

  const writeAtomic = async (state: LedgerState): Promise<LedgerState> => {
    await mkdir(options.dir, { recursive: true })
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    return state
  }

  // Lock-free read: callers that already hold the session queue (append /
  // mergeRemote) must never re-enter it, or they deadlock against themselves.
  const readUnlocked = async (): Promise<LedgerState> => {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return EMPTY
    }
    const state = parseState(raw)
    if (state) return state
    // Corrupt: keep the evidence, start clean, never throw at the host.
    try {
      await rename(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* already gone or read-only: nothing else we can do */
    }
    return EMPTY
  }

  const read = (): Promise<LedgerState> => enqueue(key, readUnlocked)

  return {
    read,

    append: (op, originClientId) =>
      enqueue(key, async () => {
        const current = await readUnlocked()
        const next: LedgerState = {
          version: current.version + 1,
          originClientId,
          ops: [...current.ops, op],
        }
        return writeAtomic(next)
      }),

    mergeRemote: (remote, localClientId) =>
      enqueue(key, async () => {
        const current = await readUnlocked()
        // Our own write coming back through the wire: not news.
        if (localClientId && remote.originClientId === localClientId) return current
        if (remote.version <= current.version) return current
        return writeAtomic({ version: remote.version, originClientId: remote.originClientId, ops: [...remote.ops] })
      }),
  }
}

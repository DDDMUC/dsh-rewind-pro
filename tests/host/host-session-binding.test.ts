// Session binding — the read path must resolve the session a request NAMES.
//
// Reproduced on a real DSH 0.2.0-rc.2 host: `commit` calls
// `sessions.fork(parent, boundary)`, and the store appends the fork child LAST
// in `sessions.list()`. While every read resolved "the newest session", the
// child supplied the epoch, `gradeUndo` compared it against the parent's
// recorded epoch, and `undo` answered `stale-epoch` forever — even with force.
// `candidates` and `plan` read the wrong session the same way.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { detectAdapter } from '../../src/host/adapter'
import { createRewindController } from '../../src/host/hooks'
import { DEFAULT_CONFIG } from '../../src/core/types'
import { cleanupTmp } from './helpers/tmp'

afterAll(cleanupTmp)

interface FakeEvent {
  type: string
  seq: number
  data: Record<string, unknown>
}

const user = (seq: number, text: string): FakeEvent => ({ type: 'user/message', seq, data: { content: text } })
const assistant = (seq: number, text: string, turn: number): FakeEvent => ({
  type: 'assistant/message',
  seq,
  data: { message: { content: text }, turn, step: 1 },
})

/** The pre-rewind log: user turns at seq 1 and 3. */
const parentEvents: FakeEvent[] = [user(1, 'write a parser'), assistant(2, 'sure', 1), user(3, 'now add tests'), assistant(4, 'ok', 2)]
/** The fork child: inherits the head only — a different epoch and different turns. */
const childEvents: FakeEvent[] = [user(1, 'write a parser'), assistant(2, 'sure', 1)]

const makeHarness = () => {
  const forkCalls: Array<{ id: string; boundary: number }> = []
  const parent = {
    id: 'parent',
    seq: 10,
    firstLiveSeq: 0,
    header: { cwd: 'w' },
    surface: { replaceGeneration: 0 },
    snapshotEvents: () => [...parentEvents],
  }
  const child = {
    id: 'child',
    seq: 6,
    firstLiveSeq: 6,
    header: { cwd: 'w', parentSession: 'parent' },
    surface: { replaceGeneration: 0 },
    snapshotEvents: () => [...childEvents],
  }
  const byId = new Map<string, (typeof parent) | (typeof child)>([
    ['parent', parent],
    ['child', child],
  ])
  const ctx = {
    sessions: {
      // The store appends the fork child last — that is the whole problem.
      list: () => [parent, child],
      get: (id: string) => byId.get(id),
      fork: (source: { id: string }, boundary: number) => {
        forkCalls.push({ id: source.id, boundary })
        return child
      },
    },
  }
  return { ctx, parent, child, byId, forkCalls }
}

describe('adapter session resolution', () => {
  it('reads the named session instead of the newest one', () => {
    const { ctx } = makeHarness()
    const adapter = detectAdapter(ctx).adapter

    expect(adapter.messagesOf('parent')).toHaveLength(4)
    expect(adapter.messagesOf()).toHaveLength(2) // default stays "newest"
    expect(adapter.sessionSeq('parent')).toBe(9)
    expect(adapter.sessionSeq()).toBe(5)
    expect(adapter.epoch('parent')).toBe('parent:0:0')
    expect(adapter.epoch()).toBe('child:6:0')
  })

  it('falls back to the newest session for an unknown id', () => {
    const { ctx } = makeHarness()
    const adapter = detectAdapter(ctx).adapter
    expect(adapter.epoch('does-not-exist')).toBe('child:6:0')
  })

  it('forks the named session, not whatever is newest', async () => {
    const { ctx, forkCalls } = makeHarness()
    const adapter = detectAdapter(ctx).adapter
    await adapter.forkSession(4, 'parent')
    expect(forkCalls).toEqual([{ id: 'parent', boundary: 4 }])
  })
})

describe('controller over a forked store', () => {
  const controllerFor = async (dir: string, ctx: unknown = makeHarness().ctx) => {
    const adapter = detectAdapter(ctx).adapter
    return createRewindController({
      adapter,
      ledgerDir: path.join(dir, 'ledgers'),
      snapshotRoot: path.join(dir, 'snapshots'),
      workspaceRoot: dir,
      config: { ...DEFAULT_CONFIG, snapshot: false },
    })
  }

  it('lists candidates per session', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rewind-binding-'))
    const controller = await controllerFor(dir)
    // Newest-first ordering, so the later user turn leads.
    expect(controller.candidates('parent').map((c) => c.seq)).toEqual([3, 1])
    expect(controller.candidates('child').map((c) => c.seq)).toEqual([1])
  })

  it('undo grades clean after a fork commit instead of refusing with stale-epoch', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rewind-binding-'))
    const controller = await controllerFor(dir)

    expect((await controller.mark({ sessionId: 'parent', targetSeq: 3 })).ok).toBe(true)
    const committed = await controller.commit({ sessionId: 'parent' })
    expect(committed.ok).toBe(true)
    // The fork really happened, and the child is now the newest session.
    expect(controller.state('parent').ranges).toEqual([{ start: 3, end: 9 }])

    const undo = await controller.undo({ sessionId: 'parent' })
    expect(undo.reason).not.toBe('stale-epoch')
    expect(undo.grade).toBe('clean')
    expect(undo.applied).toBe(true)
  })

  it('still refuses undo when the named session really was reset', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rewind-binding-'))
    const { ctx, parent, byId } = makeHarness()
    const controller = await controllerFor(dir, ctx)

    await controller.mark({ sessionId: 'parent', targetSeq: 3 })
    await controller.commit({ sessionId: 'parent' })

    // The adapter holds the store by reference, so swapping what `get` answers
    // simulates the same session id coming back with a different epoch — the
    // case the guard exists for, and the one it must still refuse.
    byId.set('parent', { ...parent, firstLiveSeq: 99, seq: 40 })
    const undo = await controller.undo({ sessionId: 'parent' })
    expect(undo.reason).toBe('stale-epoch')
    expect(undo.applied).toBe(false)
  })
})

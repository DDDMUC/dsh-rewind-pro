// Ledger replay: the append-only op log is the single source of truth. Pending
// state must survive a process restart (pure replay) and undo must be able to
// remove a committed range.

import { describe, expect, it } from 'vitest'
import { replayOps } from '../../src/core/ledger'
import type { LedgerOp, Strategy } from '../../src/core/types'

const EPOCH = 'epoch-1'

const mark = (opId: string, targetSeq: number, strategy: Strategy = 'derive-patch'): LedgerOp => ({
  kind: 'mark',
  opId,
  targetSeq,
  strategy,
  time: 1,
  epoch: EPOCH,
})

const commit = (
  opId: string,
  refOpId: string,
  start: number,
  end: number,
  strategy: Strategy = 'derive-patch',
): LedgerOp => ({ kind: 'commit', opId, refOpId, range: { start, end }, strategy, time: 2, epoch: EPOCH })

const cancel = (opId: string, refOpId: string): LedgerOp => ({ kind: 'cancel', opId, refOpId, time: 2, epoch: EPOCH })
const unwind = (opId: string, refOpId: string): LedgerOp => ({ kind: 'unwind', opId, refOpId, time: 3, epoch: EPOCH })
const jump = (opId: string, toIndex: number): LedgerOp => ({ kind: 'jump', opId, toIndex, time: 4, epoch: EPOCH })

describe('replayOps', () => {
  it('empty ledger yields no ranges, no pending, no history', () => {
    expect(replayOps([])).toEqual({ ranges: [], pending: null, history: [] })
  })

  it('mark alone is pending and hides nothing yet', () => {
    const out = replayOps([mark('m1', 7)])
    expect(out.ranges).toEqual([])
    expect(out.pending).toEqual({ opId: 'm1', targetSeq: 7, epoch: EPOCH, strategy: 'derive-patch' })
  })

  it('cancel of the pending mark leaves the conversation untouched', () => {
    const out = replayOps([mark('m1', 7), cancel('c1', 'm1')])
    expect(out.pending).toBeNull()
    expect(out.ranges).toEqual([])
  })

  it('commit records the hidden range and clears pending', () => {
    const out = replayOps([mark('m1', 5), commit('k1', 'm1', 5, 9)])
    expect(out.pending).toBeNull()
    expect(out.ranges).toEqual([{ start: 5, end: 9 }])
  })

  it('unwind removes exactly the range it references', () => {
    const out = replayOps([
      mark('m1', 5),
      commit('k1', 'm1', 5, 9),
      mark('m2', 11),
      commit('k2', 'm2', 11, 13),
      unwind('u1', 'k1'),
    ])
    expect(out.ranges).toEqual([{ start: 11, end: 13 }])
  })

  it('ignores a cancel whose mark is no longer pending and an orphan commit', () => {
    const out = replayOps([mark('m1', 5), cancel('c-old', 'nope'), commit('k1', 'm1', 5, 9), cancel('c2', 'm1')])
    expect(out.ranges).toEqual([{ start: 5, end: 9 }])
    expect(out.pending).toBeNull()
  })

  it('the newest mark supersedes an unresolved older pending', () => {
    const out = replayOps([mark('m1', 5), mark('m2', 8), commit('k2', 'm2', 8, 9)])
    expect(out.ranges).toEqual([{ start: 8, end: 9 }])
    expect(out.pending).toBeNull()
  })

  it('jump replays the ledger as of an earlier op (undo then redo)', () => {
    const ops = [mark('m1', 5), commit('k1', 'm1', 5, 9), jump('j1', 0)]
    const rewound = replayOps(ops)
    expect(rewound.ranges).toEqual([])
    expect(rewound.pending?.opId).toBe('m1')

    const redone = replayOps([...ops, jump('j2', 1)])
    expect(redone.ranges).toEqual([{ start: 5, end: 9 }])
    expect(redone.pending).toBeNull()
  })

  it('history records every op with its reversibility', () => {
    const out = replayOps([
      mark('m1', 5, 'surface-op'),
      commit('k1', 'm1', 5, 9, 'surface-op'),
      mark('m2', 11),
      commit('k2', 'm2', 11, 13),
    ])
    expect(out.history.map((h) => [h.kind, h.reversible])).toEqual([
      ['mark', true],
      ['commit', false],
      ['mark', true],
      ['commit', true],
    ])
    expect(out.history[1].targetSeq).toBe(5)
  })
})

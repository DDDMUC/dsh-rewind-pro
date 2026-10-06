// Multiple rewinds on one session.
//
// The ledger keeps every commit as its own op, and overlaps merge so the hidden
// surface is a union rather than a sum. The interesting case is undoing a rewind
// that another rewind has since swallowed: the merged surface has to *shrink*,
// not stay put.

import { describe, expect, it } from 'vitest'
import { replayDetail, replayOps } from '../../src/core/ledger'
import type { LedgerOp, Strategy } from '../../src/core/types'

const strategy: Strategy = 'derive-patch'
const epoch = 'epoch-1'

const mark = (opId: string, targetSeq: number, time: number): LedgerOp => ({
  kind: 'mark',
  opId,
  targetSeq,
  strategy,
  time,
  epoch,
})

const commit = (opId: string, refOpId: string, start: number, end: number, time: number): LedgerOp => ({
  kind: 'commit',
  opId,
  refOpId,
  range: { start, end },
  strategy,
  time,
  epoch,
})

const unwind = (opId: string, refOpId: string, time: number): LedgerOp => ({
  kind: 'unwind',
  opId,
  refOpId,
  time,
  epoch,
})

describe('multiple rewinds', () => {
  it('keeps two disjoint rewinds apart', () => {
    const ops = [mark('m1', 100, 1), commit('c1', 'm1', 100, 110, 2), mark('m2', 200, 3), commit('c2', 'm2', 200, 210, 4)]
    expect(replayOps(ops).ranges).toEqual([
      { start: 100, end: 110 },
      { start: 200, end: 210 },
    ])
  })

  it('merges overlapping rewinds into one hidden surface', () => {
    // Rewind to 100, then rewind further back to 90: the second range covers the
    // first, and the surface must read as one range rather than two.
    const ops = [mark('m1', 100, 1), commit('c1', 'm1', 100, 110, 2), mark('m2', 90, 3), commit('c2', 'm2', 90, 120, 4)]
    expect(replayOps(ops).ranges).toEqual([{ start: 90, end: 120 }])
  })

  it('keeps the surface when undoing a rewind the later one still covers', () => {
    // Rewind to 100 (hides 100..110), then rewind to 90 (hides 90..120). The
    // later rewind hides the earlier one's turns anyway, so undoing the earlier
    // one must change nothing — those turns are still gone by the other rewind.
    const ops = [
      mark('m1', 100, 1),
      commit('c1', 'm1', 100, 110, 2),
      mark('m2', 90, 3),
      commit('c2', 'm2', 90, 120, 4),
      unwind('u1', 'c1', 5),
    ]
    expect(replayOps(ops).ranges).toEqual([{ start: 90, end: 120 }])
    expect(replayDetail(ops).activeCommitIds).toEqual(['c2'])
  })

  it('gives turns back when undoing a rewind that only touched an adjacent range', () => {
    // Two rewinds whose ranges are merely adjacent merge into one hidden
    // surface (100..120). Undoing the first must hand 100..110 back and leave
    // 111..120 hidden. Removing the merged range by equality finds no match and
    // silently keeps everything hidden, which is the bug this pins.
    const ops = [
      mark('m1', 100, 1),
      commit('c1', 'm1', 100, 110, 2),
      mark('m2', 111, 3),
      commit('c2', 'm2', 111, 120, 4),
      unwind('u1', 'c1', 5),
    ]
    expect(replayOps(ops).ranges).toEqual([{ start: 111, end: 120 }])
    expect(replayDetail(ops).activeCommitIds).toEqual(['c2'])
  })
})

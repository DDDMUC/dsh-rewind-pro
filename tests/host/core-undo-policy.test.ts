// Undo grading is the honest answer to "can I take this back?".
// clean  -> nothing happened since, just do it
// dirty  -> new turns were written on top, force a second confirm and say how many
// irreversible -> the strategy cannot un-hide, offer read-only view instead

import { describe, expect, it } from 'vitest'
import { gradeUndo } from '../../src/core/undo-policy'
import type { LedgerOp, Strategy } from '../../src/core/types'

const EPOCH = 'epoch-1'

const committed = (
  markId: string,
  commitId: string,
  start: number,
  end: number,
  strategy: Strategy = 'derive-patch',
): LedgerOp[] => [
  { kind: 'mark', opId: markId, targetSeq: start, strategy, time: 1, epoch: EPOCH },
  { kind: 'commit', opId: commitId, refOpId: markId, range: { start, end }, strategy, time: 2, epoch: EPOCH },
]

describe('gradeUndo', () => {
  it('has nothing to undo on an empty ledger', () => {
    expect(gradeUndo([], { sessionSeq: 9, strategy: 'derive-patch', epoch: EPOCH })).toEqual({
      grade: 'none',
      reason: 'no-op',
    })
  })

  it('grades a rewind with no new turns as clean', () => {
    const ops = committed('m1', 'k1', 5, 9)
    expect(gradeUndo(ops, { sessionSeq: 9, strategy: 'derive-patch', epoch: EPOCH })).toEqual({
      grade: 'clean',
      opId: 'k1',
    })
  })

  it('grades a rewind with later turns as dirty and says how many diverged', () => {
    const ops = committed('m1', 'k1', 5, 9)
    expect(gradeUndo(ops, { sessionSeq: 12, strategy: 'derive-patch', epoch: EPOCH })).toEqual({
      grade: 'dirty',
      opId: 'k1',
      divergentTurns: 3,
      notice: '3 new turns were written after this rewind',
    })
  })

  it('refuses to undo across an epoch change', () => {
    const ops = committed('m1', 'k1', 5, 9)
    expect(gradeUndo(ops, { sessionSeq: 9, strategy: 'derive-patch', epoch: 'epoch-2' })).toEqual({
      grade: 'none',
      reason: 'stale-epoch',
    })
  })

  it('marks a surface-op rewind irreversible with a reason', () => {
    const ops = committed('m1', 'k1', 5, 9, 'surface-op')
    const grade = gradeUndo(ops, { sessionSeq: 9, strategy: 'surface-op', epoch: EPOCH })
    expect(grade.grade).toBe('irreversible')
    expect(grade).toHaveProperty('reason')
  })

  it('grades an older rewind as dirty when a newer one sits on top of it', () => {
    const ops = [...committed('m1', 'k1', 5, 9), ...committed('m2', 'k2', 12, 15)]
    expect(gradeUndo(ops, { sessionSeq: 15, strategy: 'derive-patch', epoch: EPOCH }, 'k1')).toMatchObject({
      grade: 'dirty',
      opId: 'k1',
      divergentTurns: 6,
    })
  })

  it('skips a rewind that was already undone', () => {
    const ops = [...committed('m1', 'k1', 5, 9), { kind: 'unwind', opId: 'u1', refOpId: 'k1', time: 3, epoch: EPOCH } as LedgerOp]
    expect(gradeUndo(ops, { sessionSeq: 9, strategy: 'derive-patch', epoch: EPOCH })).toEqual({
      grade: 'none',
      reason: 'no-op',
    })
  })
})

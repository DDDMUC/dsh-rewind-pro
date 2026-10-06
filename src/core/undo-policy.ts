// Undo grading — the honest answer to "can I take this back?".
//
//   clean        nothing was written after the rewind: just restore it
//   dirty        new turns were appended on top: force a second confirm and
//                say how many turns diverged, because un-hiding the tail will
//                splice them into a history the model never saw
//   irreversible the strategy folded the tail away for good (surface-op):
//                disable undo, offer read-only viewing of what was hidden
//   none         no-op (nothing to undo) or stale epoch (session was reset)

import { activeCommits } from './ledger.js'
import { isReversible } from './strategy.js'
import type { LedgerOp, UndoContext, UndoGrade } from './types.js'

export function gradeUndo(ops: readonly LedgerOp[], now: UndoContext, opId?: string): UndoGrade {
  const commits = activeCommits(ops)
  if (commits.length === 0) return { grade: 'none', reason: 'no-op' }

  const target = opId ? commits.find((commit) => commit.opId === opId) : commits[commits.length - 1]
  if (!target) return { grade: 'none', reason: 'no-op' }

  if (now.epoch !== undefined && target.epoch !== now.epoch) return { grade: 'none', reason: 'stale-epoch' }

  if (!isReversible(target.strategy)) {
    return {
      grade: 'irreversible',
      opId: target.opId,
      reason: `${target.strategy} folded the tail into the session surface and cannot un-hide it; open history to read what was removed`,
    }
  }

  const divergentTurns = Math.max(0, now.sessionSeq - target.range.end)
  if (divergentTurns > 0) {
    return {
      grade: 'dirty',
      opId: target.opId,
      divergentTurns,
      notice: `${divergentTurns} new turns were written after this rewind`,
    }
  }

  return { grade: 'clean', opId: target.opId }
}

// Ledger replay — the deterministic heart of the plugin.
//
// The ledger is append-only: nothing is ever edited or removed, so replaying
// it after a crash or a process restart reproduces the exact same view. Every
// op is idempotent under replay and stale ops (a cancel for a mark that is no
// longer pending, an orphan commit) are ignored rather than throwing.

import { isReversible } from './strategy.js'
import type { HiddenRange, HistoryEntry, LedgerOp, PendingState, ReplayResult } from './types.js'

export interface ReplayDetail extends ReplayResult {
  /** Op ids of commits still in effect, oldest first. */
  activeCommitIds: string[]
}

const sameRange = (a: HiddenRange, b: HiddenRange): boolean => a.start === b.start && a.end === b.end

/** Sort + merge overlapping ranges so downstream filtering can be a simple pass. */
export function mergeRanges(ranges: readonly HiddenRange[]): HiddenRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: HiddenRange[] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else out.push({ ...range })
  }
  return out
}

const isCommit = (op: LedgerOp): op is Extract<LedgerOp, { kind: 'commit' }> => op.kind === 'commit'

/**
 * Replay `ops[0..limit)`. `limit` exists so a `jump` op can recompute the
 * state of an earlier prefix; because a jump may only point backwards, every
 * recursive call works on a strictly shorter prefix and always terminates.
 */
function replayPrefix(ops: readonly LedgerOp[], limit: number): ReplayDetail {
  let ranges: HiddenRange[] = []
  let pending: PendingState | null = null
  let history: HistoryEntry[] = []
  let activeCommitIds: string[] = []

  for (let i = 0; i < limit; i++) {
    const op = ops[i]

    switch (op.kind) {
      case 'mark': {
        // A newer mark supersedes an unresolved one: the older op can no
        // longer be committed, which is exactly what two-phase rewind wants.
        pending = { opId: op.opId, targetSeq: op.targetSeq, epoch: op.epoch, strategy: op.strategy }
        history.push({ opId: op.opId, kind: 'mark', targetSeq: op.targetSeq, time: op.time, reversible: true })
        break
      }

      case 'cancel': {
        if (pending?.opId === op.refOpId) pending = null
        history.push({ opId: op.opId, kind: 'cancel', targetSeq: null, time: op.time, reversible: false })
        break
      }

      case 'commit': {
        if (pending?.opId === op.refOpId) {
          ranges = mergeRanges([...ranges, op.range])
          activeCommitIds = [...activeCommitIds, op.opId]
          pending = null
        }
        history.push({
          opId: op.opId,
          kind: 'commit',
          targetSeq: op.range.start,
          time: op.time,
          reversible: isReversible(op.strategy),
        })
        break
      }

      case 'unwind': {
        const target = ops.find((candidate) => isCommit(candidate) && candidate.opId === op.refOpId)
        if (target && isCommit(target)) {
          ranges = ranges.filter((range) => !sameRange(range, target.range))
          activeCommitIds = activeCommitIds.filter((id) => id !== target.opId)
        }
        history.push({
          opId: op.opId,
          kind: 'unwind',
          targetSeq: target && isCommit(target) ? target.range.start : null,
          time: op.time,
          reversible: false,
        })
        break
      }

      case 'jump': {
        // Jump rewinds the ledger itself (undo/redo of rewind history) and is
        // recorded, never destructive: the ops after the cursor stay on disk.
        const to = Math.max(-1, Math.min(op.toIndex, i - 1))
        const rewound = replayPrefix(ops, to + 1)
        ranges = rewound.ranges
        pending = rewound.pending
        activeCommitIds = rewound.activeCommitIds
        history = [...rewound.history, { opId: op.opId, kind: 'jump', targetSeq: null, time: op.time, reversible: true }]
        break
      }
    }
  }

  return { ranges, pending, history, activeCommitIds }
}

export function replayDetail(ops: readonly LedgerOp[]): ReplayDetail {
  return replayPrefix(ops, ops.length)
}

export function replayOps(ops: readonly LedgerOp[]): ReplayResult {
  const { ranges, pending, history } = replayDetail(ops)
  return { ranges, pending, history }
}

/** Commits still in effect, oldest first — what undo/history act on. */
export function activeCommits(ops: readonly LedgerOp[]): Array<Extract<LedgerOp, { kind: 'commit' }>> {
  const { activeCommitIds } = replayDetail(ops)
  const byId = new Map(ops.filter(isCommit).map((op) => [op.opId, op]))
  return activeCommitIds.map((id) => byId.get(id)).filter((op): op is Extract<LedgerOp, { kind: 'commit' }> => !!op)
}

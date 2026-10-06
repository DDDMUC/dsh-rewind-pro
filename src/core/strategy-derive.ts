// derive-patch — the primary masking strategy, and the reason undo exists.
//
// Instead of rewriting the session we hand the harness a patch describing
// which seq ranges to exclude from derived messages. Removing the patch (or a
// range inside it) un-hides them again, which is exactly what undo does.

import { mergeRanges } from './ledger.js'
import type { HiddenRange } from './types.js'

export interface DerivePatch {
  kind: 'hide-ranges'
  ranges: HiddenRange[]
}

export function buildDerivePatch(ranges: readonly HiddenRange[]): DerivePatch {
  return { kind: 'hide-ranges', ranges: mergeRanges(ranges) }
}

/** Undo support: drop one range so its messages come back. */
export function removeRangeFromPatch(patch: DerivePatch, range: HiddenRange): DerivePatch {
  const ranges = patch.ranges.filter((r) => !(r.start === range.start && r.end === range.end))
  return buildDerivePatch(ranges)
}

export function addRangeToPatch(patch: DerivePatch, range: HiddenRange): DerivePatch {
  return buildDerivePatch([...patch.ranges, range])
}

const hidden = (seq: number, ranges: readonly HiddenRange[]): boolean =>
  ranges.some((range) => seq >= range.start && seq <= range.end)

/** Pure: returns the messages that should remain visible for a given patch. */
export function applyDerivePatch<T extends { seq: number }>(messages: readonly T[], ranges: readonly HiddenRange[]): T[] {
  return messages.filter((message) => !hidden(message.seq, ranges))
}

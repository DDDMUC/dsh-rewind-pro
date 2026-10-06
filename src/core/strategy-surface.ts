// surface-op — degraded fallback for harnesses that cannot patch derived
// messages. The tail is folded into one placeholder message appended to the
// session surface. This is one-way: undo is impossible, so the UI must say so
// and offer read-only viewing instead.

import type { HiddenRange } from './types.js'

export interface SurfaceOp {
  type: 'replace'
  range: HiddenRange
  message: { role: 'system'; text: string }
}

export interface SurfacePlaceholder {
  placeholder: true
  range: HiddenRange
  text: string
}

export function buildSurfaceOp(range: HiddenRange, placeholderText: string): SurfaceOp {
  return { type: 'replace', range, message: { role: 'system', text: placeholderText } }
}

/**
 * Pure projection of a surface-op fold: everything before the range survives,
 * the range becomes a single placeholder. Messages after the range (written
 * later) are preserved so a newer turn never disappears.
 */
export function applySurfaceOp<T extends { seq: number }>(
  messages: readonly T[],
  ops: readonly SurfaceOp[],
): Array<T | SurfacePlaceholder> {
  if (ops.length === 0) return [...messages]

  const folded = new Set<number>()
  for (const op of ops) {
    for (let seq = op.range.start; seq <= op.range.end; seq++) folded.add(seq)
  }

  const placeholderAt = new Map<number, SurfacePlaceholder>(
    ops.map((op) => [op.range.start, { placeholder: true, range: op.range, text: op.message.text }]),
  )

  const out: Array<T | SurfacePlaceholder> = []
  let lastSeq = -Infinity
  for (const message of messages) {
    const placeholder = placeholderAt.get(message.seq)
    if (placeholder) out.push(placeholder)
    if (!folded.has(message.seq)) out.push(message)
    lastSeq = Math.max(lastSeq, message.seq)
  }
  // A fold that starts past the last message still needs its placeholder.
  for (const [start, placeholder] of placeholderAt) {
    if (start > lastSeq) out.push(placeholder)
  }
  return out
}

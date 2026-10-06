// Masking strategies. derive-patch is the primary path because it is
// reversible; surface-op and ui-only are degradations that must be visible to
// the user, never silent.

import { describe, expect, it } from 'vitest'
import { chooseStrategy, isBetterStrategy } from '../../src/core/strategy'
import { applyDerivePatch, buildDerivePatch, removeRangeFromPatch } from '../../src/core/strategy-derive'
import { applySurfaceOp, buildSurfaceOp } from '../../src/core/strategy-surface'
import type { SurfacePlaceholder } from '../../src/core/strategy-surface'
import type { MessageLite } from '../../src/core/types'

const messages: MessageLite[] = [
  { seq: 1, role: 'user', text: 'a' },
  { seq: 2, role: 'assistant', text: 'b' },
  { seq: 3, role: 'user', text: 'c' },
  { seq: 4, role: 'assistant', text: 'd' },
  { seq: 5, role: 'user', text: 'e' },
]

describe('chooseStrategy', () => {
  it('prefers derive-patch when the harness can patch derived messages', () => {
    expect(chooseStrategy({ canPatchDeriveMessages: true, canAppendSurfaceOp: true }, 'auto')).toEqual({
      strategy: 'derive-patch',
    })
  })

  it('degrades to surface-op when only the surface can be appended to', () => {
    expect(chooseStrategy({ canPatchDeriveMessages: false, canAppendSurfaceOp: true }, 'auto')).toEqual({
      strategy: 'surface-op',
    })
  })

  it('falls back to ui-only when the harness exposes nothing', () => {
    expect(chooseStrategy({ canPatchDeriveMessages: false, canAppendSurfaceOp: false }, 'auto')).toEqual({
      strategy: 'ui-only',
    })
  })

  it('degrades an explicit preference loudly instead of silently', () => {
    const choice = chooseStrategy({ canPatchDeriveMessages: false, canAppendSurfaceOp: false }, 'derive-patch')
    expect(choice.strategy).toBe('ui-only')
    expect(choice.degradedFrom).toBe('derive-patch')
    expect(choice.reason).toContain('derive-patch')
  })

  it('ranks derive-patch as more reversible than surface-op', () => {
    expect(isBetterStrategy('derive-patch', 'surface-op')).toBe(true)
    expect(isBetterStrategy('surface-op', 'derive-patch')).toBe(false)
  })
})

describe('derive-patch strategy', () => {
  it('hides exactly the seq ranges it is given', () => {
    const patch = buildDerivePatch([{ start: 3, end: 4 }])
    expect(applyDerivePatch(messages, patch.ranges).map((m) => m.seq)).toEqual([1, 2, 5])
  })

  it('removing a range from the patch un-hides it (undo)', () => {
    const patch = buildDerivePatch([{ start: 3, end: 4 }])
    const afterUndo = removeRangeFromPatch(patch, { start: 3, end: 4 })
    expect(afterUndo.ranges).toEqual([])
    expect(applyDerivePatch(messages, afterUndo.ranges).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('is idempotent: applying the same patch twice changes nothing', () => {
    const patch = buildDerivePatch([{ start: 2, end: 3 }])
    const once = applyDerivePatch(messages, patch.ranges)
    expect(applyDerivePatch(once, patch.ranges).map((m) => m.seq)).toEqual(once.map((m) => m.seq))
  })
})

describe('surface-op strategy', () => {
  it('folds the hidden range into a single placeholder message', () => {
    const op = buildSurfaceOp({ start: 3, end: 5 }, '3 turns hidden by rewind')
    const out = applySurfaceOp(messages, [op])
    const isPlaceholder = (m: MessageLite | SurfacePlaceholder): m is SurfacePlaceholder =>
      (m as SurfacePlaceholder).placeholder === true
    expect(out.map((m) => (isPlaceholder(m) ? 'pill' : m.seq))).toEqual([1, 2, 'pill'])
    expect(out[2]).toMatchObject({ text: '3 turns hidden by rewind' })
  })

  it('records that this fold cannot be undone', () => {
    const op = buildSurfaceOp({ start: 3, end: 5 }, 'hidden')
    expect(op.type).toBe('replace')
    expect(op.range).toEqual({ start: 3, end: 5 })
  })
})

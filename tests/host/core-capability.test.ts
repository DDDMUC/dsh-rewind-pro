// Capability probing: ask the harness once, cache the answer, and re-ask when
// the harness version changes or the cache is invalidated (self-healing after
// an upgrade) — never on every keystroke.

import { describe, expect, it, vi } from 'vitest'
import { createCapabilityCache, detectCapability } from '../../src/core/capability'

const probeOf = (version: string, canPatch: boolean, canSurface: boolean) => ({
  dshVersion: () => version,
  canPatchDeriveMessages: () => canPatch,
  canAppendSurfaceOp: () => canSurface,
})

describe('detectCapability', () => {
  it('picks derive-patch and stays reversible on a fully capable harness', () => {
    const cap = detectCapability(probeOf('0.1.2-rc.1', true, true))
    expect(cap).toEqual({
      dshVersion: '0.1.2-rc.1',
      canPatchDeriveMessages: true,
      canAppendSurfaceOp: true,
      reversible: true,
      chosen: 'derive-patch',
    })
  })

  it('marks surface-op as not reversible', () => {
    const cap = detectCapability(probeOf('0.1.2-rc.1', false, true))
    expect(cap.chosen).toBe('surface-op')
    expect(cap.reversible).toBe(false)
  })

  it('treats ui-only as reversible because nothing was changed on the session', () => {
    const cap = detectCapability(probeOf('0.1.2-rc.1', false, false))
    expect(cap.chosen).toBe('ui-only')
    expect(cap.reversible).toBe(true)
  })
})

describe('capability cache', () => {
  it('probes once and serves later reads from cache', () => {
    const probe = probeOf('0.1.2-rc.1', true, true)
    const spy = vi.spyOn(probe, 'canPatchDeriveMessages')
    const cache = createCapabilityCache(probe)
    cache.get()
    cache.get()
    cache.get()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('re-probes after an explicit invalidate', () => {
    const probe = probeOf('0.1.2-rc.1', true, true)
    const spy = vi.spyOn(probe, 'canPatchDeriveMessages')
    const cache = createCapabilityCache(probe)
    cache.get()
    cache.invalidate()
    cache.get()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('self-heals when the harness version changes under us', () => {
    let version = '0.1.2-rc.1'
    let canPatch = false
    const cache = createCapabilityCache({
      dshVersion: () => version,
      canPatchDeriveMessages: () => canPatch,
      canAppendSurfaceOp: () => true,
    })
    expect(cache.get().chosen).toBe('surface-op')
    version = '0.1.3'
    canPatch = true
    expect(cache.get().chosen).toBe('derive-patch')
  })

  it('peek returns null until the first probe', () => {
    const cache = createCapabilityCache(probeOf('0.1.2-rc.1', true, true))
    expect(cache.peek()).toBeNull()
    cache.get()
    expect(cache.peek()?.chosen).toBe('derive-patch')
  })
})

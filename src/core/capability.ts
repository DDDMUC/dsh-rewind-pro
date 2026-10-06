// Capability probing with caching and self-healing invalidation.
//
// Probing touches the harness, so it happens once per process and is cached.
// The cache key is the harness version: when DSH is upgraded underneath us the
// next read re-probes automatically, so the strategy can silently improve from
// ui-only to derive-patch without a config change.

import { chooseStrategy } from './strategy.js'
import type { Capability } from './types.js'

export interface CapabilityProbe {
  dshVersion: () => string
  canPatchDeriveMessages: () => boolean
  canAppendSurfaceOp: () => boolean
}

export function detectCapability(probe: CapabilityProbe): Capability {
  const canPatchDeriveMessages = probe.canPatchDeriveMessages()
  const canAppendSurfaceOp = probe.canAppendSurfaceOp()
  const { strategy } = chooseStrategy({ canPatchDeriveMessages, canAppendSurfaceOp }, 'auto')
  return {
    dshVersion: probe.dshVersion(),
    canPatchDeriveMessages,
    canAppendSurfaceOp,
    reversible: strategy !== 'surface-op',
    chosen: strategy,
  }
}

export interface CapabilityCache {
  get: () => Capability
  /** Force the next read to re-probe (e.g. after a session resume). */
  invalidate: () => void
  peek: () => Capability | null
}

export function createCapabilityCache(probe: CapabilityProbe): CapabilityCache {
  let cached: Capability | null = null

  return {
    get() {
      const version = probe.dshVersion()
      // Version drift means the harness changed under us: re-probe so an
      // upgrade can upgrade our strategy too.
      if (cached && cached.dshVersion !== version) cached = null
      if (!cached) cached = detectCapability(probe)
      return cached
    },
    invalidate() {
      cached = null
    },
    peek() {
      return cached
    },
  }
}

// Strategy selection: reversibility decides the strategy.

import type { Capability, Strategy } from './types.js'

export interface StrategyCapabilities {
  canPatchDeriveMessages: boolean
  canAppendSurfaceOp: boolean
}

export interface StrategyChoice {
  strategy: Strategy
  /** Set when the requested strategy was unavailable and we degraded. */
  degradedFrom?: Strategy
  reason?: string
}

const RANK: Record<Strategy, number> = { 'derive-patch': 0, 'surface-op': 1, 'ui-only': 2 }

/**
 * surface-op folds the tail into the session surface: there is no way back, so
 * undo must be disabled and the UI offers read-only viewing instead.
 * ui-only never touched the session, so it is trivially reversible.
 */
export function isReversible(strategy: Strategy): boolean {
  return strategy !== 'surface-op'
}

/**
 * Pick the most reversible strategy the harness actually supports.
 * `auto` prefers derive-patch (undoable), then surface-op, then ui-only.
 * An explicit preference is honoured when supported, otherwise we degrade and
 * say so instead of silently doing something else.
 */
export function chooseStrategy(caps: StrategyCapabilities, preferred: 'auto' | Strategy): StrategyChoice {
  if (preferred !== 'auto') {
    const supported =
      (preferred === 'derive-patch' && caps.canPatchDeriveMessages) ||
      (preferred === 'surface-op' && caps.canAppendSurfaceOp) ||
      preferred === 'ui-only'
    if (supported) return { strategy: preferred }
    const fallback = autoStrategy(caps)
    return {
      strategy: fallback,
      degradedFrom: preferred,
      reason: `requested ${preferred} is unavailable on this harness; using ${fallback}`,
    }
  }
  return { strategy: autoStrategy(caps) }
}

function autoStrategy(caps: StrategyCapabilities): Strategy {
  if (caps.canPatchDeriveMessages) return 'derive-patch'
  if (caps.canAppendSurfaceOp) return 'surface-op'
  return 'ui-only'
}

/** Lower rank = more reversible. Used to detect self-healing upgrades. */
export function isBetterStrategy(candidate: Strategy, current: Strategy): boolean {
  return RANK[candidate] < RANK[current]
}

/** Human-facing one-liner for the settings card and the mode popover. */
export function describeStrategy(capability: Pick<Capability, 'chosen' | 'reversible'>): string {
  if (capability.chosen === 'derive-patch') return 'derive-patch: hides the tail reversibly, undo restores it'
  if (capability.chosen === 'surface-op') return 'surface-op: folds the tail away; undo is unavailable'
  return `ui-only: hides the tail in this view${capability.reversible ? '' : ' (harness surface unavailable)'}`
}

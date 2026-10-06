// Does this harness let a plugin decide what the model sees?
//
// A branch-per-version conversation model needs the request history to follow
// the *selected* path, and the only sanctioned way is
// `ctx.sessions.registerMessageProjection`. The published contract promises
// content rewriting only; *deletion* (a projection returning null) works through
// an implementation detail upstream may close at any time, so it is probed
// rather than assumed — and a failed probe leaves the caller on the fork path,
// which is reversible and always available.
//
// Two safety rules, both learned the hard way:
//
//   1. The probe owns its event type. Registrations live on the SessionStore, so
//      they are host-wide, not per-session: probing with `user/message` would
//      mean a projection that deletes *every* user message of *every* session,
//      and a failed dispose would leave it armed. `rewind/selftest` can only
//      ever affect the probe's own throwaway event.
//   2. `prepare()` builds a session that is never `enter()`ed, so the probe
//      never reaches the store, the session list or any publication hook.

export interface ProjectionVerdict {
  /** `registerMessageProjection` exists on the sessions service. */
  registration: boolean
  /** A projection returning `null` actually removed a message from the derivation. */
  deletion: boolean
  /** Why the probe failed, plus what the service did expose. For the log/health. */
  reason?: string
}

/** The probe's own event type: anything it leaks can only touch its own events. */
const PROBE_TYPE = 'rewind/selftest'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

/**
 * Read a method reference WITHOUT invoking it.
 *
 * Kept separate from `call` on purpose: using the invoker to fetch a reference
 * executes the method with no arguments, and anything that dereferences its
 * parameter then throws into the swallow below — which reads as "this API does
 * not exist" while also firing the method's side effects far too early.
 */
const method = <T>(holder: unknown, name: string): T | undefined => {
  const fn = asRecord(holder)?.[name]
  return typeof fn === 'function' ? (fn as T) : undefined
}

const call = <T>(holder: unknown, name: string, ...args: unknown[]): T | undefined => {
  const record = asRecord(holder)
  const fn = method<(...a: unknown[]) => T>(holder, name)
  if (!fn) return undefined
  try {
    return fn.call(record, ...args)
  } catch {
    return undefined
  }
}

/** The service members that would matter, so a "missing" verdict is actionable. */
function memberDump(sessions: unknown): string {
  try {
    const record = asRecord(sessions)
    if (!record) return `service is ${typeof sessions}`
    const proto = Object.getPrototypeOf(record) as object | null
    const names = new Set<string>([
      ...Object.getOwnPropertyNames(record),
      ...(proto ? Object.getOwnPropertyNames(proto) : []),
    ])
    const relevant = [...names].filter((name) => /projection|derive|prepare|fork|create|enter|session/i.test(name))
    return relevant.length > 0 ? `saw: ${relevant.slice(0, 14).join(', ')}` : 'saw no session-ish members'
  } catch (error) {
    return `dump failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Probe the projection route once, against a throwaway session.
 *
 * @param sessions - the harness `sessions` service.
 * @returns the verdict; never throws, because a probe must not take the host down.
 */
export async function probeMessageProjection(sessions: unknown): Promise<ProjectionVerdict> {
  const register = method<(projection: unknown) => unknown>(sessions, 'registerMessageProjection')
  if (typeof register !== 'function') {
    return { registration: false, deletion: false, reason: `registerMessageProjection missing (${memberDump(sessions)})` }
  }

  const session = call<Record<string, unknown>>(sessions, 'prepare', 'rewind-pro-selftest')
  if (!session) {
    return { registration: true, deletion: false, reason: 'prepare() unavailable' }
  }

  let dispose: (() => Promise<void>) | undefined
  try {
    call(session, 'append', PROBE_TYPE, { text: 'rewind-pro self-check' })
    const derived = call<unknown[]>(session, 'deriveMessages')
    if (!Array.isArray(derived)) {
      return { registration: true, deletion: false, reason: 'deriveMessages() unavailable' }
    }
    const before = derived.length
    if (before === 0) {
      return { registration: true, deletion: false, reason: `probe event produced no message (type ${PROBE_TYPE})` }
    }

    const registered = call<() => Promise<void>>(sessions, 'registerMessageProjection', {
      // Deleting every message of the throwaway session is the bluntest possible
      // test of the null path — and with our own event type it can only ever hit
      // the probe's own event, even if the dispose below fails.
      type: PROBE_TYPE,
      project: () => null,
    })
    if (typeof registered !== 'function') {
      return { registration: true, deletion: false, reason: 'registration returned no disposer' }
    }
    dispose = registered

    const after = call<unknown[]>(session, 'deriveMessages')?.length
    if (typeof after !== 'number') {
      return { registration: true, deletion: false, reason: 'deriveMessages unavailable after projection' }
    }
    return after < before
      ? { registration: true, deletion: true }
      : {
          registration: true,
          deletion: false,
          reason: `projection did not remove a message (${String(before)} → ${String(after)})`,
        }
  } catch (error) {
    return {
      registration: true,
      deletion: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    try {
      await dispose?.()
    } catch {
      /* the probe session is throwaway; a failed dispose is not worth surfacing */
    }
  }
}

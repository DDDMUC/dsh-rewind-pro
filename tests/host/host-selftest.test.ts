// The projection self-check decides whether the branch/"current path" feature can
// steer the request history, and it must never take the host down: every failure
// path has to come back as a verdict, because the caller's fallback is the fork
// path — reversible, always available.
//
// The fake is stateful on purpose. A fake that answers from a constant cannot
// tell "the projection removed the message" apart from "the derivation was empty
// to begin with", which is exactly the difference the probe measures.

import { describe, expect, it } from 'vitest'
import { probeMessageProjection } from '../../src/host/selftest'

interface Harness {
  registerMessageProjection?: (projection: { type?: string; project?: (message: unknown) => unknown }) => unknown
  prepare?: (id?: string) => unknown
}

/**
 * A sessions service that behaves like the harness:
 * `append` grows the derivation, and a registered projection filters it.
 */
function harness(options: { register?: boolean; prepare?: boolean; removes?: boolean } = {}): Harness {
  const events: { type: string; data: unknown }[] = []
  let projecting: string | null = null

  const session = {
    append: (type: string, data: unknown) => {
      events.push({ type, data })
      return { seq: events.length }
    },
    // One message per event, minus whatever the active projection drops.
    deriveMessages: () =>
      events
        .filter((event) => !(projecting !== null && options.removes !== false && event.type === projecting))
        .map((event) => ({ role: 'user', content: [{ type: 'text', text: String(event.type) }] })),
  }

  const api: Harness = {}
  if (options.prepare !== false) api.prepare = () => session
  if (options.register !== false) {
    api.registerMessageProjection = (projection) => {
      projecting = projection.type ?? null
      return async () => {
        projecting = null
      }
    }
  }
  return api
}

describe('probeMessageProjection', () => {
  it('reports unsupported when the registration API is absent', async () => {
    const verdict = await probeMessageProjection(harness({ register: false }))
    expect(verdict.registration).toBe(false)
    expect(verdict.deletion).toBe(false)
    expect(verdict.reason).toContain('registerMessageProjection missing')
  })

  it('names the members it did see, so a "missing" verdict is actionable', async () => {
    const verdict = await probeMessageProjection({ prepare: () => undefined, fork: () => undefined })
    expect(verdict.reason).toContain('saw:')
    expect(verdict.reason).toContain('prepare')
  })

  it('reports registration without deletion when no private session can be built', async () => {
    const verdict = await probeMessageProjection(harness({ prepare: false }))
    expect(verdict.registration).toBe(true)
    expect(verdict.deletion).toBe(false)
    expect(verdict.reason).toBe('prepare() unavailable')
  })

  it('confirms deletion when a null projection shrinks the derivation', async () => {
    await expect(probeMessageProjection(harness())).resolves.toEqual({ registration: true, deletion: true })
  })

  it('reports deletion as unsupported when the projection changes nothing', async () => {
    const verdict = await probeMessageProjection(harness({ removes: false }))
    expect(verdict.registration).toBe(true)
    expect(verdict.deletion).toBe(false)
    expect(verdict.reason).toContain('did not remove a message')
  })

  it('probes with its own event type, never a built-in one', async () => {
    // Registrations are host-wide on the SessionStore: probing with
    // `user/message` would arm a projection that deletes every user message of
    // every session, and a failed dispose would leave it armed.
    const seen: string[] = []
    const base = harness()
    const registering = base.registerMessageProjection
    base.registerMessageProjection = (projection) => {
      seen.push(projection.type ?? '<none>')
      return registering?.(projection)
    }
    await probeMessageProjection(base)
    expect(seen).toEqual(['rewind/selftest'])
  })

  it('survives a host whose registration throws when used', async () => {
    // Reading a reference must not invoke it (that is how the probe once
    // misreported "missing" and armed a projection before its session existed),
    // so a throwing implementation still counts as *present* — and using it must
    // come back as a verdict, not an exception.
    const hostile = harness()
    hostile.registerMessageProjection = () => {
      throw new Error('nope')
    }
    const verdict = await probeMessageProjection(hostile)
    expect(verdict.registration).toBe(true)
    expect(verdict.deletion).toBe(false)
    expect(verdict.reason).toBe('registration returned no disposer')
  })

  it('reports a missing API as missing, whatever the service throws', async () => {
    const verdict = await probeMessageProjection({
      registerMessageProjection: () => {
        throw new Error('nope')
      },
    })
    // No `prepare`: registration stands, deletion cannot be tested.
    expect(verdict.registration).toBe(true)
    expect(verdict.deletion).toBe(false)
    expect(verdict.reason).toBe('prepare() unavailable')
  })

  it('never throws, whatever the service looks like', async () => {
    for (const value of [undefined, null, 42, 'sessions', {}, { prepare: 7 }, { prepare: () => ({}) }]) {
      const verdict = await probeMessageProjection(value)
      expect(typeof verdict.registration).toBe('boolean')
      expect(typeof verdict.deletion).toBe('boolean')
    }
  })
})

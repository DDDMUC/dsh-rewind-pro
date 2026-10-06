// The client half must survive the guarded ctx.
//
// Every ctx property read other than a declared service is a rejection in the
// browser: the fiber goes FAILED and the shell reports
// "web boot: 1 entry did not activate → dsh-rewind-pro: failed", with no error
// detail anywhere. So this test hands `apply` a ctx that behaves like the real
// guard — undeclared reads throw — and requires it to activate anyway.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as entry from '../../src/client/index'
import { apply, inject, pickTurnTarget } from '../../src/client/index'

/** Mirrors the harness facade: `get` is free, bare reads need a declaration. */
function guardedContext(services: Record<string, unknown>): Record<string, unknown> {
  const declared = new Set(inject)
  const verbs = new Set(['effect', 'on', 'once', 'provide'])
  const effects: Array<() => void> = []
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'get') return (name: string) => services[name]
      if (prop === '__effects') return effects
      if (typeof prop !== 'string') return undefined
      if (verbs.has(prop)) {
        // The real facade forwards lifecycle verbs straight to the fiber.
        return (body: unknown) => {
          if (typeof body === 'function') {
            const result = (body as () => unknown)()
            if (typeof result === 'function') effects.push(result as () => void)
          }
          return undefined
        }
      }
      if (declared.has(prop)) return services[prop]
      // The real guard rejects rather than returning undefined; a returning
      // `get` here would silently pass a plugin that reads undeclared services.
      throw new Error(`service "${prop}" is not declared by your plugin`)
    },
  })
}

const noopSlots = {
  inject: () => undefined,
  register: () => () => undefined,
}

let dispose: (() => void) | null = null

beforeEach(() => {
  // happy-dom ships a real EventSource that would dial the SSE endpoint; the
  // transport treats its absence as "no live stream", which is what we want here.
  vi.stubGlobal('EventSource', undefined)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 40,
    right: 320,
    bottom: 80,
    left: 20,
    width: 300,
    height: 40,
    x: 20,
    y: 40,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  dispose?.()
  dispose = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('client half entry', () => {
  it('declares the services it reads', () => {
    expect(inject).toEqual(['slots'])
    expect(entry.default.inject).toEqual(['slots'])
    expect(typeof entry.default.apply).toBe('function')
  })

  it('activates against a ctx that rejects undeclared property reads', () => {
    const ctx = guardedContext({ slots: noopSlots, uiSession: undefined, sessions: undefined, locale: undefined })
    const handle = apply(ctx as never, { apiPrefix: '/api/dsh-rewind-pro' })
    expect(typeof handle.dispose).toBe('function')
    dispose = handle.dispose
  })

  it('activates when only the declared service exists', () => {
    const ctx = guardedContext({ slots: noopSlots })
    const handle = apply(ctx as never)
    expect(handle.store.get()).toBeNull()
    dispose = handle.dispose
  })

  it('the guarded fake really rejects undeclared reads', () => {
    const ctx = guardedContext({ slots: noopSlots })
    expect(() => (ctx as Record<string, unknown>).sessionId).toThrow(/not declared/)
    expect(() => (ctx as Record<string, unknown>).config).toThrow(/not declared/)
  })

  it('uses the session id it resolved from the uiSession binding source', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: unknown) => {
      calls.push(String(url))
      return { ok: false, json: async () => ({}) }
    })
    const ctx = guardedContext({ slots: noopSlots, uiSession: { current: { value: { id: 'session-abc' } } } })
    const handle = apply(ctx as never)
    dispose = handle.dispose
    await vi.waitFor(() => expect(calls.some((url) => url.includes('session-abc'))).toBe(true))
  })

  it("falls back to the shell's own current-session pointer, prefix intact", async () => {
    // This runtime's own localStorage global is a methodless shell, so install a
    // real Storage contract rather than depending on the environment's.
    const data = new Map<string, string>([['dsh.sessions.current', '{"sessionId":"session-abc-123"}']])
    const fakeStorage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size
      },
    }
    Object.defineProperty(window, 'localStorage', { value: fakeStorage, configurable: true })

    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: unknown) => {
      calls.push(String(url))
      return { ok: false, json: async () => ({}) }
    })
    const ctx = guardedContext({ slots: noopSlots })
    const handle = apply(ctx as never)
    dispose = handle.dispose
    // The `session-` prefix matters: the bare uuid resolves to nothing on the
    // host, which then answers with a different conversation's candidates.
    await vi.waitFor(() => expect(calls.some((url) => url.includes('sessionId=session-abc-123'))).toBe(true))
  })

  it('survives a storage global that has no methods', async () => {
    Object.defineProperty(window, 'localStorage', { value: {}, configurable: true })
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: unknown) => {
      calls.push(String(url))
      return { ok: false, json: async () => ({}) }
    })
    const ctx = guardedContext({ slots: noopSlots })
    const handle = apply(ctx as never)
    dispose = handle.dispose
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.every((url) => url.includes('sessionId=unknown'))).toBe(true)
  })

  it('a superseded activation can no longer tear the live surface down', () => {
    // The bug this pins: a later activation deleted the earlier one's nodes while
    // its observers and React root stayed alive, so the overlay the user could see
    // belonged to an activation with no candidate list — and no ↶ ever appeared.
    const ctx = guardedContext({ slots: noopSlots })
    const first = apply(ctx as never)
    const second = apply(ctx as never)
    first.dispose()
    expect(document.querySelectorAll('[data-plugin="dsh-rewind-pro"]').length).toBeGreaterThan(0)
    dispose = second.dispose
  })

  it('does not stack overlays when activation runs twice', () => {
    // Hot reload after a `?v` bump re-activates without a page reload; a leaked
    // container means the user sees every ↶ button twice. Two elements carry the
    // marker per activation (the React container and the button overlay), so the
    // property to hold is "does not grow".
    const ctx = guardedContext({ slots: noopSlots })
    const first = apply(ctx as never)
    const afterOne = document.querySelectorAll('[data-plugin="dsh-rewind-pro"]').length
    expect(afterOne).toBeGreaterThan(0)
    const second = apply(ctx as never)
    expect(document.querySelectorAll('[data-plugin="dsh-rewind-pro"]').length).toBe(afterOne)
    dispose = () => {
      first.dispose()
      second.dispose()
    }
  })

  it('registers slots in the harness order: options first, component second', () => {
    // The regression this pins: `slots.register(Component)` was rejected by the
    // seat ("needs an options object with a `name`") and the rejection was caught
    // and swallowed, so no surface of this plugin had ever mounted.
    const calls: Array<{ options: unknown; component: unknown }> = []
    const slots = {
      register: (options: unknown, component: unknown) => {
        calls.push({ options, component })
        return () => undefined
      },
      inject: (_name: string, factory: () => unknown) => {
        factory()
        return () => undefined
      },
    }
    const ctx = guardedContext({ slots })
    const handle = apply(ctx as never)
    dispose = handle.dispose
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(typeof call.options).toBe('object')
      expect(call.options).not.toBeNull()
      expect(typeof (call.options as { name?: unknown }).name).toBe('string')
      expect(typeof call.component).toBe('function')
    }
  })

  it('picks the user turn a turn tail belongs to', () => {
    const candidates = [
      { seq: 40, preview: 'newest' },
      { seq: 31, preview: 'middle' },
      { seq: 12, preview: 'oldest' },
    ]
    expect(pickTurnTarget(45, candidates)).toBe(40)
    expect(pickTurnTarget(40, candidates)).toBe(31)
    expect(pickTurnTarget(13, candidates)).toBe(12)
    // Nothing below the boundary, or no boundary at all: no button, never a guess.
    expect(pickTurnTarget(5, candidates)).toBeNull()
    expect(pickTurnTarget(undefined, candidates)).toBeNull()
  })

  it('does not invent a session id when nothing exposes one', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: unknown) => {
      calls.push(String(url))
      return { ok: false, json: async () => ({}) }
    })
    const ctx = guardedContext({ slots: noopSlots })
    const handle = apply(ctx as never)
    dispose = handle.dispose
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.every((url) => url.includes('sessionId=unknown'))).toBe(true)
  })
})

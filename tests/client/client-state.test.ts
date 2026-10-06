// Client state: one store per tab, fed by SSE and by other tabs over
// BroadcastChannel. Two rules keep the tabs honest:
//   * a state at or below our version is dropped (monotonic version)
//   * our own echo (same originClientId) is dropped

import { afterEach, describe, expect, it } from 'vitest'
import { createRewindStore } from '../../src/client/state'
import type { SessionView } from '../../src/client/contract'

const view = (version: number): SessionView => ({
  version,
  sessionId: 's1',
  ranges: [],
  pending: null,
  history: [],
  capability: {
    dshVersion: '0.1.2-rc.1',
    canPatchDeriveMessages: true,
    canAppendSurfaceOp: false,
    reversible: true,
    chosen: 'derive-patch',
  },
  epoch: 'e1',
})

const stores: Array<{ dispose: () => void }> = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

const makeStore = (clientId: string) => {
  const store = createRewindStore({ sessionId: 's1', clientId, transport: { fetch: async () => ({ ok: true, json: async () => view(0) }), events: () => () => {} } })
  stores.push(store)
  return store
}

describe('createRewindStore', () => {
  it('starts empty and takes the first state it is given', () => {
    const store = makeStore('tab-a')
    expect(store.get()).toBeNull()
    store.applyRemote(view(1), 'tab-b')
    expect(store.get()?.version).toBe(1)
  })

  it('drops a state that is not newer', () => {
    const store = makeStore('tab-a')
    store.applyRemote(view(5), 'tab-b')
    store.applyRemote(view(3), 'tab-b')
    expect(store.get()?.version).toBe(5)
  })

  it('drops its own echo', () => {
    const store = makeStore('tab-a')
    store.applyRemote(view(1), 'tab-b')
    store.applyRemote(view(9), 'tab-a')
    expect(store.get()?.version).toBe(1)
  })

  it('notifies subscribers only when something changed', () => {
    const store = makeStore('tab-a')
    const seen: number[] = []
    store.subscribe(() => seen.push(store.get()?.version ?? -1))
    store.applyRemote(view(1), 'tab-b')
    store.applyRemote(view(1), 'tab-b')
    expect(seen).toEqual([1])
  })

  it('stops notifying after unsubscribe', () => {
    const store = makeStore('tab-a')
    const seen: number[] = []
    const unsubscribe = store.subscribe(() => seen.push(1))
    store.applyRemote(view(1), 'tab-b')
    unsubscribe()
    store.applyRemote(view(2), 'tab-b')
    expect(seen).toEqual([1])
  })

  it('exposes derived flags the UI branches on', () => {
    const store = makeStore('tab-a')
    store.applyRemote({ ...view(1), pending: { opId: 'm1', targetSeq: 4, epoch: 'e1', strategy: 'derive-patch' } }, 'tab-b')
    expect(store.isPending()).toBe(true)
    expect(store.canUndo()).toBe(false)
  })
})

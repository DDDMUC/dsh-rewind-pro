// Cross-tab state: SSE from the host plus BroadcastChannel between tabs.
//
// Two rules keep the tabs from fighting:
//   * monotonic version — a state at or below ours is dropped
//   * echo suppression — a state carrying our own client id is dropped

import { eventsPath, parseSseChunk, apiPath } from './contract.js'
import type { SessionView } from './contract.js'
import type { HiddenRange } from '../core/types.js'

export interface Transport {
  fetch: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
  events: (url: string, onChunk: (chunk: string) => void) => () => void
}

export interface StoreOptions {
  sessionId: string
  clientId: string
  transport: Transport
  prefix?: string
  channel?: string
  /** BroadcastChannel is optional (older webviews): absence is not an error. */
  broadcast?: boolean
}

export interface RewindStore {
  get: () => SessionView | null
  subscribe: (listener: () => void) => () => void
  applyRemote: (view: SessionView, originClientId?: string) => void
  refresh: () => Promise<void>
  connect: () => () => void
  isPending: () => boolean
  hiddenRanges: () => HiddenRange[]
  canUndo: () => boolean
  dispose: () => void
}

const CHANNEL = 'dsh-rewind-pro'

export function createRewindStore(options: StoreOptions): RewindStore {
  const { sessionId, clientId, transport } = options
  const prefix = options.prefix ?? undefined

  let current: SessionView | null = null
  const listeners = new Set<() => void>()
  const unsubscribers: Array<() => void> = []

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  const set = (view: SessionView): void => {
    current = view
    notify()
  }

  /** Adopt a remote state only when it is strictly newer and not our own echo. */
  const applyRemote = (view: SessionView, originClientId?: string): void => {
    if (originClientId && originClientId === clientId) return
    if (current && view.version <= current.version) return
    set(view)
  }

  const refresh = async (): Promise<void> => {
    try {
      const response = await transport.fetch(apiPath('/state', { sessionId }, prefix))
      if (!response.ok) return
      const view = (await response.json()) as SessionView
      if (typeof view?.version === 'number') applyRemote(view, 'host')
    } catch {
      /* offline: keep the last known state */
    }
  }

  const connect = (): (() => void) => {
    const stopEvents = transport.events(eventsPath(sessionId, prefix), (chunk) => {
      for (const message of parseSseChunk(chunk)) {
        const view = message.data as SessionView
        if (typeof view?.version === 'number') applyRemote(view, 'host')
      }
    })
    unsubscribers.push(stopEvents)

    if (options.broadcast !== false && typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(options.channel ?? CHANNEL)
      channel.onmessage = (event: MessageEvent) => {
        const payload = event.data as { sessionId?: string; view?: SessionView; originClientId?: string }
        if (!payload || payload.sessionId !== sessionId || !payload.view) return
        applyRemote(payload.view, payload.originClientId)
      }
      const stopChannel = () => channel.close()
      unsubscribers.push(stopChannel)
      // Fan our own changes out so other tabs converge without polling.
      const fan = () => {
        if (!current) return
        channel.postMessage({ sessionId, view: current, originClientId: clientId })
      }
      listeners.add(fan)
      unsubscribers.push(() => listeners.delete(fan))
    }

    void refresh()
    return () => unsubscribers.splice(0).forEach((stop) => stop())
  }

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    applyRemote,
    refresh,
    connect,
    isPending: () => Boolean(current?.pending),
    hiddenRanges: () => current?.ranges ?? [],
    canUndo: () => {
      if (!current) return false
      // Undo is offered only when there is something committed and reversible.
      const committed = current.history.some((entry) => entry.kind === 'commit' && entry.reversible)
      return committed && !current.pending && current.capability.reversible
    },
    dispose: () => {
      unsubscribers.splice(0).forEach((stop) => stop())
      listeners.clear()
    },
  }
}

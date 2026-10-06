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
  /**
   * The session this store currently speaks for. Read it at call time: the GUI
   * switches conversations without reloading the page, so a value captured at
   * activation goes stale the moment someone clicks another chat.
   */
  sessionId: () => string
  /**
   * Re-point at another session.
   *
   * Without this the plugin kept answering for whatever conversation was open
   * when the page loaded — the give-away was the dock pill reporting the same
   * "hidden" count in every conversation, because every conversation was asking
   * the first one's ledger.
   *
   * @returns whether the session actually changed.
   */
  setSession: (sessionId: string) => boolean
  dispose: () => void
}

const CHANNEL = 'dsh-rewind-pro'

export function createRewindStore(options: StoreOptions): RewindStore {
  const { clientId, transport } = options
  const prefix = options.prefix ?? undefined
  let sessionId = options.sessionId

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

  /** Stop the streams `connect()` opened, so a session switch can re-open them. */
  let stopStreams: (() => void) | null = null

  const connect = (): (() => void) => {
    const stop = (): void => unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
    stopStreams = stop
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
    return stop
  }

  /**
   * Re-point at another session: everything this store holds is per-session
   * (the view, the ledger it mirrors, the SSE stream and the channel), so the
   * old state is dropped rather than merged, and the stream is re-opened on the
   * new id.
   */
  const setSession = (next: string): boolean => {
    if (next === sessionId) return false
    sessionId = next
    current = null
    const wasStreaming = stopStreams !== null
    stopStreams?.()
    stopStreams = null
    notify()
    if (wasStreaming) connect()
    else void refresh()
    return true
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
    sessionId: () => sessionId,
    setSession,
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

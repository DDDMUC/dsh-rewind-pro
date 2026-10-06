// Client half entry: registers slot components and mounts the DOM bridge.
//
// Slots follow the harness rule: `ctx.slots.inject(name, () => ctx.slots
// .register(Component))`, always defensively — an unknown slot name is a
// skipped feature, never a broken page. Everything the components need is
// passed as props, because slot components do not get a ctx.

import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRewindStore } from './state.js'
import { createDraftStash } from './draft-stash.js'
import { ensureStyles } from './styles.js'
import { pickLanguage, strings } from './locales.js'
import { mountRewindButtons, type RewindButtonLayerHandle } from './rewind-button.js'
import { IconRewind } from './icons.js'
import { PendingBanner } from './banner.js'
import { CollapsedPill } from './collapsed-pill.js'
import { HistoryPanel } from './history-panel.js'
import { SettingsCard } from './settings-card.js'
import { ImpactPopover } from './popover.js'
import { apiPath, postJson } from './contract.js'
import type { CandidatesResponse, SessionView, UndoResponse } from './contract.js'
import type { Capability, ImpactPlan, PluginConfig, RewindCandidate } from '../core/types.js'

interface SlotsApi {
  inject?: (name: string, factory: () => unknown) => void
  /** Harness order: the options object (with `name`) comes first, the component second. */
  register?: (options: unknown, component: unknown) => unknown
}

/**
 * The ctx a web client half actually receives.
 *
 * `slots` is the one service this half declares, so it is the only ctx property
 * it may read directly. Every other property read is a service access gated by
 * the fiber's `inject` declaration, and an undeclared one is a hard rejection
 * that marks the whole entry FAILED — which is what the browser then reports as
 * "web boot: 1 entry did not activate → dsh-rewind-pro: failed". Optional
 * lookups go through `ctx.get(name)`, which needs no declaration.
 */
export interface ClientContext {
  slots?: SlotsApi
  get?: (name: string) => unknown
  /** Loader lifecycle hook: the returned callback runs when this fiber unloads. */
  effect?: (body: () => unknown) => unknown
}

/** Cordis services this client half declares; keep in sync with the reads below. */
export const inject = ['slots']

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

/** Pull an id out of a session-ish value: plain record, binding source, or getter. */
function idOf(source: unknown): string | undefined {
  const rec = asRecord(source)
  if (!rec) return undefined
  if (typeof rec.id === 'string' && rec.id) return rec.id
  if (typeof rec.sessionId === 'string' && rec.sessionId) return rec.sessionId
  const nested = asRecord(rec.value)
  if (nested) {
    if (typeof nested.id === 'string' && nested.id) return nested.id
    if (typeof nested.sessionId === 'string' && nested.sessionId) return nested.sessionId
  }
  const read = rec.get
  if (typeof read === 'function') {
    const resolved = asRecord((read as () => unknown).call(rec))
    if (resolved) {
      if (typeof resolved.id === 'string' && resolved.id) return resolved.id
      if (typeof resolved.sessionId === 'string' && resolved.sessionId) return resolved.sessionId
    }
  }
  return undefined
}

/**
 * The session the web app is currently showing, as it persists it itself.
 *
 * `uiSession` hands out a renderer binding source, not a plain id, so the ctx
 * probe above usually comes up empty — and then every API call carries
 * `sessionId=unknown`, which the host answers by falling back to its newest
 * session. The candidates then belong to a different conversation, no anchor
 * text pairs with them, and the plugin looks dead while reporting no error at
 * all. The shell's own pointer is the reliable source; it is JSON, and the id it
 * carries keeps its `session-` prefix (the bare uuid resolves to nothing).
 */
function readStoredSessionId(): string | undefined {
  const stores = [readStore('localStorage'), readStore('sessionStorage')]
  for (const store of stores) {
    if (!store) continue
    for (const key of ['dsh.sessions.current', 'dsh.session.current']) {
      const raw = store.getItem(key)?.trim()
      if (!raw) continue
      const fromJson = asRecord(parseJson(raw))?.sessionId
      if (typeof fromJson === 'string' && fromJson) return fromJson
      // Not the JSON shape: accept the raw string, unquoted if it was a JSON string.
      const bare = raw.replace(/^"(.*)"$/, '$1').trim()
      if (bare) return bare
    }
  }
  return undefined
}

function readStore(name: 'localStorage' | 'sessionStorage'): Storage | undefined {
  try {
    const store: unknown = typeof window === 'undefined' ? undefined : (window[name] as unknown)
    // Presence is not enough: some runtimes expose a localStorage-shaped global
    // with no methods at all, and calling into it would kill activation.
    return typeof (store as Storage | undefined)?.getItem === 'function' ? (store as Storage) : undefined
  } catch {
    // Privacy modes can throw on mere access.
    return undefined
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * The session this page is showing.
 *
 * Probes the ctx services first, then the shell's own pointer, and only then
 * gives up (empty string) rather than inventing an id: a call against the wrong
 * session is worse than no call.
 */
function resolveSessionId(ctx: ClientContext): string {
  for (const name of ['uiSession', 'sessions']) {
    const service = asRecord(ctx.get?.(name))
    if (!service) continue
    const id = idOf(service.current) ?? idOf(service.session) ?? idOf(service.active)
    if (id) return id
  }
  return readStoredSessionId() ?? ''
}

/** Locale service first; the browser's own preference otherwise. */
function resolveLanguage(ctx: ClientContext): string | undefined {
  const locale = asRecord(ctx.get?.('locale'))
  for (const key of ['language', 'locale', 'current']) {
    const value = locale?.[key]
    if (typeof value === 'string' && value) return value
    const nested = asRecord(value)?.language
    if (typeof nested === 'string' && nested) return nested
  }
  return typeof navigator === 'undefined' ? undefined : navigator.language
}

const clientId = `tab-${Math.random().toString(36).slice(2, 10)}`

const transport = {
  fetch: async (url: string) => fetch(url),
  events: (url: string, onChunk: (chunk: string) => void) => {
    if (typeof EventSource === 'undefined') return () => undefined
    const source = new EventSource(url)
    const forward = (event: MessageEvent) => onChunk(`data: ${String(event.data)}\n\n`)
    source.addEventListener('state', forward as EventListener)
    source.onmessage = forward
    return () => source.close()
  },
}

export interface ClientHandle {
  dispose: () => void
  store: ReturnType<typeof createRewindStore>
}

/**
 * The single live client surface for this page.
 *
 * Activation is not once-per-page (module re-arrival, config reload, duplicate
 * host entry), so every later activation supersedes the previous one — and the
 * superseded one must run its own teardown, not just lose its nodes.
 */
let liveSurface: ClientHandle | null = null

export function apply(ctx: ClientContext, injectedConfig?: Partial<PluginConfig>): ClientHandle {
  // One live surface per page. Activation runs again on every `?v` bump, module
  // re-arrival or duplicate host entry, and deleting the previous *nodes* while
  // leaving its closures, observers and React root alive produced the worst
  // possible outcome: the overlay the user could see belonged to an activation
  // whose candidate list was still empty, so no ↶ button ever appeared even
  // though the newest lane had a perfect match. Supersede the previous
  // activation properly instead — it owns its own teardown.
  liveSurface?.dispose()

  ensureStyles()

  // Plugin config arrives as the second argument (the module system calls
  // `apply(ctx, config)`); there is no `ctx.config` to read.
  const config: Partial<PluginConfig> = injectedConfig ?? {}
  const sessionId = resolveSessionId(ctx) || 'unknown'
  const text = strings(pickLanguage(resolveLanguage(ctx)))
  const store = createRewindStore({ sessionId, clientId, transport, ...(config.apiPrefix ? { prefix: config.apiPrefix } : {}) })
  const stash = createDraftStash(sessionId)

  // Our own container, attached to a stable ancestor. We never write into a
  // React-managed node of the harness.
  const container = document.createElement('div')
  container.dataset.plugin = 'dsh-rewind-pro'
  document.body.appendChild(container)
  let root: Root | null = null

  const state = {
    view: store.get(),
    impact: null as ImpactPlan | null,
    historyOpen: false,
  }

  const render = (): void => {
    state.view = store.get()
    if (!root) root = createRoot(container)
    root.render(<ClientSurface state={state} store={store} text={text} config={config} onAction={act} />)
  }

  const refreshImpact = async (targetSeq: number): Promise<void> => {
    const response = await fetch(`/api/dsh-rewind-pro/plan?sessionId=${encodeURIComponent(sessionId)}&targetSeq=${targetSeq}`)
    if (!response.ok) return
    const body = (await response.json()) as { impact?: ImpactPlan }
    state.impact = body.impact ?? null
    render()
  }

  async function act(action: Action): Promise<void> {
    switch (action.kind) {
      case 'mark': {
        // The host stashes the draft; the client only needs to remember it in
        // case this tab is the one that cancels later.
        const current = store.get()
        if (current?.pending) return
        await postJson('/mark', { sessionId, targetSeq: action.targetSeq }, prefixOptions())
        state.impact = null
        await store.refresh()
        render()
        break
      }
      case 'cancel':
        await postJson('/cancel', { sessionId }, prefixOptions())
        await store.refresh()
        render()
        break
      case 'undo': {
        const response = await postJson<UndoResponse>(
          '/undo',
          { sessionId, ...(action.opId ? { opId: action.opId } : {}), ...(action.force ? { force: true } : {}) },
          prefixOptions(),
        )
        // dirty: make the user confirm the divergence before we splice history.
        if (response.data && response.data.grade === 'dirty' && !action.force) {
          const ok = window.confirm(response.data.notice ?? text.undoDirty(response.data.divergentTurns ?? 0))
          if (ok) await act({ ...action, force: true })
          return
        }
        await store.refresh()
        render()
        break
      }
      case 'jump':
        await postJson('/jump', { sessionId, toIndex: action.toIndex }, prefixOptions())
        await store.refresh()
        render()
        break
      case 'preview':
        await refreshImpact(action.targetSeq)
        break
      case 'history':
        state.historyOpen = action.open
        render()
        break
      case 'dismiss':
        state.impact = null
        render()
        break
    }
  }

  const prefixOptions = (): { prefix?: string } => (config.apiPrefix ? { prefix: config.apiPrefix } : {})

  // The DOM carries no seq for a user turn, so the ↶ anchors are paired with
  // the host's candidate list. It is cached here and reloaded whenever the
  // store moves (SSE from another tab, or one of our own actions), which is
  // also when new user turns can appear.
  let candidates: RewindCandidate[] = []
  let buttons: RewindButtonLayerHandle | null = null

  const loadCandidates = async (): Promise<void> => {
    try {
      const response = await transport.fetch(apiPath('/candidates', { sessionId }, config.apiPrefix))
      if (!response.ok) return
      const body = (await response.json()) as CandidatesResponse
      if (!Array.isArray(body?.candidates)) return
      candidates = body.candidates
      buttons?.refresh()
    } catch {
      /* offline: keep the last known candidates */
    }
  }

  const onRewind = (seq: number): void => {
    void act({ kind: 'preview', targetSeq: seq })
    void act({ kind: 'mark', targetSeq: seq })
  }

  const onStoreUpdate = (): void => {
    render()
    void loadCandidates()
  }

  const unsubscribe = store.subscribe(onStoreUpdate)
  const stopEvents = store.connect()
  // connect() only notifies after a successful first fetch, so load once here
  // as well: without candidates there are no buttons at all.
  void loadCandidates()

  const registered = registerSlots(ctx, text, config, store)

  // The ↶ control itself is injected into each user row: that is where people
  // look for it, and being a row child means the browser lays it out — no
  // coordinates, no overlay. The slot surfaces above are cards and pills; none
  // of them can put a button next to a message, because the user row's action
  // strip is hard-coded in the shell and exposes no seat.
  buttons = mountRewindButtons({
    onRewind,
    candidates: () => candidates,
    activeSeq: store.get()?.pending?.targetSeq ?? null,
    label: text.rewindShort,
  })

  const dispose = (): void => {
    unsubscribe()
    stopEvents()
    buttons?.dispose()
    root?.unmount()
    container.remove()
    store.dispose()
    if (liveSurface === handle) liveSurface = null
  }

  const handle: ClientHandle = { store, dispose }
  liveSurface = handle

  // The loader disposes a fiber by running its effects; the object we return is
  // not itself a disposer contract, so hand it the teardown explicitly.
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)

  return handle
}

export type Action =
  | { kind: 'mark'; targetSeq: number }
  | { kind: 'cancel' }
  | { kind: 'undo'; opId?: string; force?: boolean }
  | { kind: 'jump'; toIndex: number }
  | { kind: 'preview'; targetSeq: number }
  | { kind: 'history'; open: boolean }
  | { kind: 'dismiss' }

interface SurfaceProps {
  state: { view: SessionView | null; impact: ImpactPlan | null; historyOpen: boolean }
  store: ReturnType<typeof createRewindStore>
  text: ReturnType<typeof strings>
  config: Partial<PluginConfig>
  onAction: (action: Action) => void
}

function ClientSurface({ state, store, text, config, onAction }: SurfaceProps): React.ReactElement | null {
  const view = state.view
  if (!view) return null

  const hiddenTurns = view.ranges.reduce((sum, range) => sum + (range.end - range.start + 1), 0)

  return (
    <>
      {view.pending && <PendingBanner targetSeq={view.pending.targetSeq} onCancel={() => onAction({ kind: 'cancel' })} text={text} />}
      {!view.pending && (
        <CollapsedPill
          hiddenTurns={hiddenTurns}
          canUndo={store.canUndo()}
          onUndo={() => onAction({ kind: 'undo' })}
          onOpenHistory={() => onAction({ kind: 'history', open: true })}
          text={text}
        />
      )}
      {state.historyOpen && (
        <HistoryPanel
          history={view.history}
          onJump={(toIndex) => onAction({ kind: 'jump', toIndex })}
          onUndo={(opId) => onAction({ kind: 'undo', opId })}
          onClose={() => onAction({ kind: 'history', open: false })}
          text={text}
        />
      )}
      {state.impact && (
        <ImpactPreview
          impact={state.impact}
          irreversible={!view.capability.reversible}
          text={text}
          onConfirm={() => onAction({ kind: 'dismiss' })}
          onCancel={() => onAction({ kind: 'dismiss' })}
        />
      )}
      {config.debug && <SettingsCard capability={view.capability} snapshotEnabled={config.snapshot !== false} trackSubagent={config.trackSubagent !== false} text={text} />}
    </>
  )
}

function ImpactPreview(props: {
  impact: ImpactPlan
  irreversible: boolean
  text: ReturnType<typeof strings>
  onConfirm: () => void
  onCancel: () => void
}): React.ReactElement {
  return <ImpactPopover {...props} />
}

/**
 * Register slot components. Every slot is optional: a harness without that
 * slot simply gets fewer surfaces, and the button bridge still works.
 */
function registerSlots(
  ctx: ClientContext,
  text: ReturnType<typeof strings>,
  config: Partial<PluginConfig>,
  store: ReturnType<typeof createRewindStore>,
): string[] {
  const slots = ctx.slots
  const registered: string[] = []
  if (!slots?.inject || !slots.register) return registered

  const candidates: Array<{ name: string; order?: number; component: () => React.ReactElement | null }> = [
    {
      name: 'settings',
      component: () => {
        const view = store.get()
        if (!view) return null
        return (
          <SettingsCard
            capability={view.capability}
            snapshotEnabled={config.snapshot !== false}
            trackSubagent={config.trackSubagent !== false}
            text={text}
          />
        )
      },
    },
    {
      name: 'dock',
      component: () => {
        const view = store.get()
        if (!view) return null
        const hiddenTurns = view.ranges.reduce((sum, range) => sum + (range.end - range.start + 1), 0)
        return (
          <CollapsedPill
            hiddenTurns={hiddenTurns}
            canUndo={store.canUndo()}
            onUndo={async () => {
              await postJson('/undo', { sessionId: view.sessionId }, config.apiPrefix ? { prefix: config.apiPrefix } : {})
              await store.refresh()
            }}
            onOpenHistory={() => undefined}
            text={text}
          />
        )
      },
    },
  ]

  for (const candidate of candidates) {
    try {
      // `register(options, component)` — options FIRST. Passing the component as
      // the options object is rejected by the seat ("needs an options object with
      // a `name`") and the rejection used to be swallowed here, so not one of
      // these surfaces had ever actually mounted.
      slots.inject(candidate.name, () =>
        slots.register?.({ name: candidate.name, id: 'dsh-rewind-pro', order: candidate.order }, candidate.component),
      )
      registered.push(candidate.name)
    } catch {
      /* slot unavailable on this build */
    }
  }
  return registered
}

/**
 * The user turn a turn's tail belongs to.
 *
 * The turn-tail seat hands out the turn's final seq; the user message that
 * opened that turn is the newest user turn strictly below it. Candidates arrive
 * newest-first, so the first one below the boundary is the answer. Returning
 * null (no button) beats guessing: a rewind lands wherever it is told to.
 */
export function pickTurnTarget(
  turnSeq: number | undefined,
  candidates: readonly Pick<RewindCandidate, 'seq'>[],
): number | null {
  if (typeof turnSeq !== 'number' || !Number.isFinite(turnSeq)) return null
  for (const candidate of candidates) {
    if (candidate.seq < turnSeq) return candidate.seq
  }
  return null
}

/** The ↶ control that rides the native turn tail row. */
function TurnRewindAction(props: {
  candidates: () => readonly RewindCandidate[]
  text: ReturnType<typeof strings>
  onRewind: (targetSeq: number) => void
}): React.ReactElement | null {
  const seq = (props as { seq?: number }).seq
  const target = pickTurnTarget(seq, props.candidates())
  if (target === null) return null
  return (
    <button
      type="button"
      className="dsh-rewind-pro-turn"
      title={props.text.rewindShort}
      aria-label={props.text.rewindShort}
      onClick={() => props.onRewind(target)}
    >
      <IconRewind />
    </button>
  )
}

/**
 * Put the real reason on the page.
 *
 * The shell only ever renders `dsh-rewind-pro: failed`: the guard rejects by
 * throwing, the boot audit keeps only the state name, and the message reaches
 * neither the console nor the host log. Without this, a broken client half is
 * indistinguishable from a dozen different causes.
 */
function reportActivationFailure(error: unknown): void {
  const detail =
    error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
  try {
    console.error('[dsh-rewind-pro] client half failed to activate:', error)
  } catch {
    /* console may be unavailable; the panel below still reports */
  }
  try {
    const panel = document.createElement('pre')
    panel.dataset.rewindProError = ''
    panel.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:72vw;max-height:40vh;overflow:auto;background:#7f1d1d;color:#fff;font:12px/1.45 ui-monospace,monospace;padding:10px 12px;border-radius:8px;white-space:pre-wrap'
    panel.textContent = `[dsh-rewind-pro] 客户端激活失败：\n${detail}`
    document.body.append(panel)
  } catch {
    /* nothing left to report with */
  }
}

/** Activation entry: same plugin, but a failure explains itself instead of vanishing. */
function activate(ctx: ClientContext, config?: Partial<PluginConfig>): ClientHandle {
  try {
    return apply(ctx, config)
  } catch (error) {
    reportActivationFailure(error)
    throw error
  }
}

/**
 * Object form on purpose. `inject` has no declaration site on a plain function,
 * so a function-returning client half cannot legally read `ctx.slots` at all —
 * and `name` keeps the loader entry identifiable in boot diagnostics.
 */
export default { name: 'rewind-pro', inject, apply: activate }

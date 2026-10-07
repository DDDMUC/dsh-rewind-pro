// The host half never calls the harness directly. Everything goes through
// HarnessAdapter, and the adapter is *detected* at runtime.
//
// Binding rules (learned the hard way on a live harness):
//   * cordis ctx is a strict proxy — reading a property outside the plugin's
//     inject list THROWS ("cannot get property X without inject"). Every ctx
//     read goes through safeGet and degrades instead of crashing.
//   * Services used: `ctx.sessions` (SessionStore), `ctx.webServer`
//     (route registration). Both are declared in the module `inject` list or
//     probed defensively.
//   * The session is event-sourced: `session.seq` is the log length, surface
//     events carry `surfaceOp` ('append' | {op:'replace',startSeq,endSeq}), and
//     `deriveMessages()` is the derived model history.
//   * Commands live on the `commands` service (`ctx.commands.register`), not on
//     a `ctx.registerCommand` method — that method never existed on the host
//     ctx, and cordis 4 throws instead of returning undefined for it.
//   * `ctx.get(name, false)` reads a service WITHOUT the inject requirement;
//     prefer it for optional services so the module inject list stays minimal.

import { randomUUID } from 'node:crypto'
import type { HiddenRange, MessageLite, PluginConfig } from '../core/types.js'
import type { SurfaceOp } from '../core/strategy-surface.js'
import type { ShadowPlan, SurfaceEventLike } from '../core/surface-window.js'
import { planShadow } from '../core/surface-window.js'
import { probeMessageProjection as runProjectionProbe } from './selftest.js'

/** 插件身份：写进替身事件的 source，便于事后辨认日志里是谁写的。 */
const PLUGIN_ID = 'dsh-rewind-pro'

/** 可能承载 surfaceOp 的四种事件类型（DSH 的 surface 契约）。 */
const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/** Minimal structural view of the live harness objects we touch. */
interface LiveSession {
  id: string
  seq: number
  firstLiveSeq?: number
  header?: { cwd?: string; parentSession?: string; origin?: string; delegationDepth?: number }
  snapshotEvents?: (from?: number, to?: number) => unknown[]
  requestHeader?: () => unknown
  deriveMessages?: () => unknown[]
  surface?: { nodes?: readonly number[]; replaceGeneration?: number }
  forkable?: boolean
}

interface LiveSessions {
  get?: (id: string) => LiveSession | undefined
  list?: () => LiveSession[]
  fork?: (source: unknown, boundary?: number, childId?: string) => LiveSession
}

export interface HarnessAdapter {
  dshVersion: () => string
  sessionId: () => string
  /** Session ids that are live right now (the session switcher source). */
  sessionIds: () => string[]
  /**
   * Epoch of the named session, or of the newest one when omitted.
   *
   * Every read takes an optional session id on purpose. The store appends a
   * `commit` fork's child LAST, so "the newest session" stops being the session
   * a request is about the moment a rewind forks — the child then supplies the
   * epoch, `gradeUndo` compares it against the parent's recorded epoch, and
   * undo refuses with `stale-epoch` forever. Resolving by id keeps each
   * operation on its own session; omitting the id keeps the newest-session
   * default for callers that genuinely have no target (the slash commands).
   */
  epoch: (sessionId?: string) => string
  messagesOf: (sessionId?: string) => MessageLite[]
  sessionSeq: (sessionId?: string) => number
  canPatchDeriveMessages: () => boolean
  patchDeriveMessages: (ranges: HiddenRange[]) => Promise<boolean>
  canAppendSurfaceOp: (sessionId?: string) => boolean
  appendSurfaceOp: (op: SurfaceOp, sessionId?: string) => Promise<boolean>
  /**
   * 遮蔽一个 surface 窗口（追加式日志的唯一改法：写一个带 replace 的替身事件）。
   *
   * 写入序列抄自 `dsh-rerun-turn` 的 `buildShadowWrites`：合成一个记账回合
   * （turn/start → step/start → 替身 → step/end → turn/end），替身是**空内容的
   * system/message**。刻意不用可见的 user 消息当替身：提示词随后要由
   * `promptSession` 重新送进去，否则界面上会出现两条提示词。
   *
   * `expectedSeq` 是规划时看到的日志长度；不符就整体拒绝（半截写入会留下悬空回合）。
   */
  shadowWindow: (
    sessionId: string | undefined,
    plan: ShadowPlan,
    expectedSeq?: number,
  ) => Promise<{ ok: boolean; reason?: string }>
  /**
   * 读会话日志并规划遮蔽窗口（原始事件不出适配器）。
   *
   * `expectedSeq` 是规划时看到的日志长度，交给写入端做乐观并发保护。
   */
  planShadowFor: (
    targetSeq: number,
    sessionId?: string,
  ) => ({ ok: true; plan: ShadowPlan; expectedSeq?: number } | { ok: false; reason: string })
  /**
   * 真的让模型重新生成：`sessionController.prompt`。
   *
   * 它会**追加一条新的用户消息**并触发一次生成；调用方负责先把旧窗口遮蔽掉，
   * 否则历史里会有两份提示词。
   */
  promptSession: (sessionId: string, text: string) => Promise<{ ok: boolean; reason?: string }>
  /** Whether the reversible rewind primitive (session fork) is available. */
  canFork: () => boolean
  /**
   * Self-check for the message-projection route — "can a plugin decide what the
   * model sees?". Cached: the probe builds a throwaway session, so it runs at
   * most once per process. See host/selftest.ts.
   */
  probeMessageProjection: () => Promise<{ registration: boolean; deletion: boolean; reason?: string }>
  /** Stop the running turn so the tail stops growing while pending. */
  interruptTurn: () => Promise<boolean>
  setDraft: (text: string) => Promise<boolean>
  getDraft: () => string | null
  /** Create a child session ending at `boundary` (inclusive) — the reversible rewind. */
  forkSession: (boundary: number, sessionId?: string) => Promise<{ ok: boolean; childId?: string; reason?: string }>
  /** Ask the web client to follow a session switch (best effort). */
  followSession: (sessionId: string) => Promise<boolean>
  /**
   * Register one slash command; a no-op when the host offers no registry.
   * `registry` is the lazily-injected `commands` service when the caller has
   * one — registering at apply time races the concurrently-loading loader.
   */
  registerCommand: (spec: CommandSpec, registry?: unknown) => void
}

/** One slash-command registration destined for the harness command registry. */
export interface CommandSpec {
  /** Lowercase command name without the leading slash. */
  name: string
  /** Human-readable summary shown in command discovery. */
  description: string
  /** Produces the reply text; the adapter wraps it in the harness result shape. */
  handler: (args: string) => Promise<string>
}

export interface AdapterProbe {
  /** True when something harness-shaped was found; false => headless/no-op. */
  bound: boolean
  adapter: HarnessAdapter
  notes: string[]
  /** Live session store when present (hooks subscribe through it). */
  sessions: LiveSessions | null
  /** The live session objects by id (hooks need `session/event` payloads). */
  onSessionEvent: ((handler: (session: unknown, event: unknown) => void) => void) | null
  /**
   * Subscribe to a bus event. Handlers are called with the bus's POSITIONAL
   * arguments — `session/event` is `(session, event)`, never one bag object.
   */
  onEvent: ((event: string, handler: (...args: unknown[]) => void) => void) | null
}

const UNKNOWN = '0.0.0-unknown'

/**
 * Read one property without ever throwing: cordis's ctx proxy throws for
 * properties outside the inject list, which must degrade, never crash.
 */
function safeGet<T = unknown>(holder: unknown, key: string): T | undefined {
  try {
    return (holder as Record<string, T | undefined>)?.[key]
  } catch {
    return undefined
  }
}

function safeCall<R>(holder: unknown, key: string, ...args: unknown[]): R | undefined {
  const fn = safeGet<(...a: unknown[]) => R>(holder, key)
  if (typeof fn !== 'function') return undefined
  try {
    return fn.apply(holder, args)
  } catch {
    return undefined
  }
}

/**
 * `safeCall` 的异步版：`prompt` 是 Promise，同步的 safeCall 会把它当成功，
 * 于是"调用抛错"和"调用成功"分不出来 —— 重跑必须能如实报告失败原因。
 */
async function safeCallAsync<R>(holder: unknown, key: string, ...args: unknown[]): Promise<R | undefined> {
  const fn = safeGet<(...a: unknown[]) => Promise<R>>(holder, key)
  if (typeof fn !== 'function') return undefined
  try {
    return await fn.apply(holder, args)
  } catch {
    return undefined
  }
}

/**
 * Safe adapter used when nothing harness-shaped can be found (headless runs,
 * unknown DSH build). Everything reports "unsupported" so the plugin degrades
 * to ui-only instead of throwing into the host.
 */
export function createNullAdapter(notes: string[] = []): HarnessAdapter {
  return {
    dshVersion: () => UNKNOWN,
    sessionId: () => 'unknown',
    sessionIds: () => [],
    epoch: () => 'unknown',
    messagesOf: () => [],
    sessionSeq: () => 0,
    canPatchDeriveMessages: () => false,
    patchDeriveMessages: async () => false,
    canAppendSurfaceOp: () => false,
    appendSurfaceOp: async () => false,
    shadowWindow: async () => ({ ok: false, reason: 'sessions service unavailable' }),
    planShadowFor: () => ({ ok: false, reason: 'sessions service unavailable' }),
    promptSession: async () => ({ ok: false, reason: 'sessionController service unavailable' }),
    canFork: () => false,
    probeMessageProjection: async () => ({ registration: false, deletion: false, reason: 'no sessions service' }),
    interruptTurn: async () => false,
    setDraft: async () => false,
    getDraft: () => null,
    forkSession: async () => ({ ok: false, reason: 'unavailable' }),
    followSession: async () => false,
    registerCommand: () => {
      /* nothing to register against */
    },
  }
}

/**
 * Read one optional service without the inject requirement. Cordis 4 exposes
 * `ctx.get(name, strict)`; `strict: false` also answers providers that are not
 * active yet. Returns undefined for a context that has no such API at all.
 */
function readService(ctx: unknown, name: string): AnyRecord | null {
  const viaGet = safeCall<unknown>(ctx, 'get', name, false)
  if (viaGet !== undefined) return asRecord(viaGet)
  return asRecord(safeGet(ctx, name))
}

type AnyRecord = Record<string, unknown>

const asRecord = (value: unknown): AnyRecord | null =>
  typeof value === 'object' && value !== null ? (value as AnyRecord) : null

/** ---- Session event vocabulary (dsh-session/lib/types) ------------------- */

const TOOL_WRITE_HINTS = ['str_replace_editor', 'create_file', 'write', 'edit', 'save']
const TOOL_SHELL_HINTS = ['bash', 'pwsh', 'shell', 'command', 'terminal']

interface RawToolCall {
  name: string
  path?: string
  shell?: boolean
  write?: boolean
}

function classifyTool(name: string, argsJson: string): RawToolCall {
  const lower = name.toLowerCase()
  const call: RawToolCall = { name }
  if (TOOL_SHELL_HINTS.some((hint) => lower.includes(hint))) call.shell = true
  if (TOOL_WRITE_HINTS.some((hint) => lower.includes(hint))) call.write = true
  try {
    const args = JSON.parse(argsJson) as AnyRecord
    const path = (args.path ?? args.file_path ?? args.abs_path ?? args.filename) as unknown
    if (typeof path === 'string') {
      call.path = path
      call.write = true
    }
    const command = (args.command ?? args.cmd) as unknown
    if (typeof command === 'string' && !call.shell) call.shell = true
  } catch {
    /* arguments are the model's raw JSON; unparsable is fine */
  }
  return call
}

/** Extract plain text from dsh-llm message content (string or parts). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part)
        if (!record) return ''
        if (typeof record.text === 'string') return record.text
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  if (asRecord(content) && typeof (content as AnyRecord).text === 'string') {
    return (content as AnyRecord).text as string
  }
  return ''
}

/**
 * Map the live session log into the MessageLite view core operates on.
 * Surface-eligible events (`user/message`, `assistant/message`, `tool/result`)
 * carry `surfaceOp`; tool calls ride along for the impact plan.
 *
 * Event read seam — the only place that touches the session log. `snapshotEvents()`
 * is deprecated on the host ("existing logic may remain unmigrated for now, but
 * new production calls are prohibited") and has NO synchronous replacement:
 * `eventAt`/`ownEvents` are deprecated alongside it, and the sanctioned modern
 * reader, `ctx.sessionQuery.readSession(sessionId)`, is async. The whole
 * controller read path (candidates / impact / state) is synchronous, so this
 * stays on the host-sanctioned deprecated reader until that path goes async.
 */
export function sessionToMessages(session: LiveSession): MessageLite[] {
  const events = safeCall<unknown[]>(session, 'snapshotEvents') ?? []
  const callsByTurnStep = new Map<string, RawToolCall[]>()
  const messages: MessageLite[] = []

  for (const raw of events) {
    const event = asRecord(raw)
    if (!event) continue
    const type = event.type as string
    const seq = typeof event.seq === 'number' ? event.seq : messages.length + 1
    const data = asRecord(event.data) ?? {}

    if (type === 'tool/call') {
      const key = `${data.turn}:${data.step}`
      const call = classifyTool(String(data.name ?? 'tool'), String(data.arguments ?? '{}'))
      const list = callsByTurnStep.get(key) ?? []
      list.push(call)
      callsByTurnStep.set(key, list)
      continue
    }

    if (type === 'user/message') {
      messages.push({ seq, role: 'user', text: textOf(data.content) })
      continue
    }

    if (type === 'assistant/message') {
      const message = asRecord(data.message) ?? {}
      const key = `${data.turn}:${data.step}`
      const toolCalls = callsByTurnStep.get(key)
      messages.push({
        seq,
        role: 'assistant',
        text: textOf(message.content),
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      })
      continue
    }

    if (type === 'tool/result') {
      // Tool results are surface-eligible but ride with their assistant step;
      // the UI folds them there instead of showing raw payloads.
      continue
    }
  }

  return messages
}

/**
 * Walk the real harness surface and bind what exists. Every binding is
 * optional; unbound ones fall back to null-adapter behaviour so a partial
 * match still loads and serves the API.
 */
export function detectAdapter(ctx: unknown): AdapterProbe {
  const notes: string[] = []
  const sessions = safeGet<LiveSessions>(ctx, 'sessions')
  const version =
    safeGet<string>(ctx, 'dshVersion') ??
    (safeGet<AnyRecord>(ctx, 'dsh') ? safeGet<string>(safeGet(ctx, 'dsh'), 'version') : undefined) ??
    safeGet<string>(readService(ctx, 'dshVersion'), 'version') ??
    safeGet<string>(readService(ctx, 'dsh'), 'version') ??
    UNKNOWN

  if (!sessions || typeof sessions.list !== 'function') {
    notes.push('ctx.sessions unavailable (headless or inject missing)')
    return {
      bound: false,
      adapter: createNullAdapter(notes),
      notes,
      sessions: null,
      onSessionEvent: null,
      onEvent: typeof safeGet(ctx, 'on') === 'function' ? (event, handler) => safeCall(ctx, 'on', event, handler) : null,
    }
  }

  const live = (id: string): LiveSession | undefined => safeCall<LiveSession>(sessions, 'get', id)

  const latest = (): LiveSession | undefined => {
    const all = safeCall<LiveSession[]>(sessions, 'list') ?? []
    return all.length > 0 ? all[all.length - 1] : undefined
  }

  /**
   * The session an operation is about: the named one when the caller knows it,
   * otherwise the newest. See `HarnessAdapter.epoch` for why the id matters.
   */
  const resolve = (sessionId?: string): LiveSession | undefined => {
    if (sessionId) {
      const named = live(sessionId)
      if (named) return named
    }
    return latest()
  }

  const messagesOfSession = (session: LiveSession | undefined): MessageLite[] =>
    session ? sessionToMessages(session) : []

  const epochOf = (session: LiveSession | undefined): string => {
    if (!session) return 'unknown'
    const seed = typeof session.firstLiveSeq === 'number' ? session.firstLiveSeq : 0
    const replaces = safeGet<number>(session.surface, 'replaceGeneration') ?? 0
    return `${session.id}:${seed}:${replaces}`
  }

  /**
   * Masking via the harness's own surface fold: append a surface-eligible
   * event whose surfaceOp replaces the tail range. This is the one-way
   * strategy (surface-op); the reversible path is forkSession.
   *
   * The payload uses the host's current `SurfaceOp` spelling — `startSeq` /
   * `endSeq`, each an existing surface node — because `{start,end}` (the shape
   * this plugin was written against) is no longer what `Session.append`
   * accepts.
   */
  const surfaceFold = async (session: LiveSession, ranges: HiddenRange[]): Promise<boolean> => {
    const range = ranges[ranges.length - 1]
    if (!range) return true
    // Node 0 holds the system prompt and the harness refuses to rewrite it
    // ("may be rewritten only by a system/message over exactly that node"), so a
    // fold that reached back that far would be rejected wholesale. Clamp to the
    // first rewriteable node instead.
    const start = Math.max(1, range.start)
    const end = Math.max(start, range.end)
    const hidden = end - start + 1
    const append = safeCall<unknown>(
      session,
      'append',
      'user/message',
      // A real user message rather than a bare `{ content: '<string>' }`:
      // `Session.append` does not validate the shape, so a malformed payload is
      // accepted and then reaches the model as `role: undefined` with string
      // content instead of text blocks.
      {
        role: 'user',
        content: [{ type: 'text', text: `[rewind] ${String(hidden)} earlier turns hidden` }],
        source: { kind: 'user' },
      },
      {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
        sourceEventSeqs: Array.from({ length: hidden }, (_, index) => start + index),
      },
    )
    return append !== undefined
  }

  let projectionVerdict: Promise<{ registration: boolean; deletion: boolean; reason?: string }> | null = null

  /**
   * 遮蔽窗口：合成一个记账回合 + 一个空内容的 system 替身，替身带 replace。
   *
   * 顺序照 `dsh-rerun-turn`：turn/start → step/start → 替身 → step/end → turn/end。
   * 回合号必须接在日志已有的最大值之后（`plan.turn` 由 foldSurface 算好）。
   */
  const shadowWindow = async (
    sessionId: string | undefined,
    plan: ShadowPlan,
    expectedSeq?: number,
  ): Promise<{ ok: boolean; reason?: string }> => {
    const session = resolve(sessionId)
    if (!session) return { ok: false, reason: 'no live session' }
    const observed = typeof session.seq === 'number' ? session.seq : undefined
    if (typeof expectedSeq === 'number' && observed !== expectedSeq) {
      return { ok: false, reason: `stale: expected seq ${String(expectedSeq)}, found ${String(observed)}` }
    }

    const carrier = {
      turn: plan.turn,
      step: 1,
      message: {
        id: randomUUID(),
        role: 'system',
        content: [] as unknown[],
        source: { kind: 'system-prompt', plugin: PLUGIN_ID, carrierFor: 'surface-shadow' },
      },
    }
    const writes: { type: string; data: unknown; opts?: Record<string, unknown> }[] = [
      { type: 'turn/start', data: { turn: plan.turn } },
      { type: 'step/start', data: { turn: plan.turn, step: 1 } },
      {
        type: 'system/message',
        data: carrier,
        opts: {
          surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
          sourceEventSeqs: [...plan.shadowed],
        },
      },
      { type: 'step/end', data: { turn: plan.turn, step: 1 } },
      { type: 'turn/end', data: { turn: plan.turn, reason: { kind: 'completed' } } },
    ]

    for (const write of writes) {
      const args: unknown[] = write.opts ? [write.opts] : []
      const landed = safeCall<unknown>(session, 'append', write.type, write.data, ...args)
      if (landed === undefined) {
        return { ok: false, reason: `append ${write.type} failed` }
      }
    }
    return { ok: true }
  }

  /**
   * 读日志、规划遮蔽窗口。
   *
   * 两种日志形态都要能吃下：正常情况 surface 事件带 `surfaceOp:'append'`（替身带
   * `{op:'replace',…}`）；但整份日志一个 `surfaceOp` 都没有时，如果只认标记，
   * 窗口会算成空 → 用户看到的是"点了没反应"。那种日志按事件类型兜底识别 surface
   * 节点。只在**完全没有标记**时兜底，避免把已被遮蔽的节点又算回来。
   */
  const planShadowFor = (
    targetSeq: number,
    sessionId?: string,
  ): { ok: true; plan: ShadowPlan; expectedSeq?: number } | { ok: false; reason: string } => {
    const session = resolve(sessionId)
    if (!session) return { ok: false, reason: 'no live session' }
    const events = safeCall<SurfaceEventLike[]>(session, 'snapshotEvents') ?? []
    const marked = events.some((event) => event.surfaceOp !== undefined)
    const normalized = marked
      ? events
      : events.map((event) =>
          SURFACE_TYPES.has(event.type) ? { ...event, surfaceOp: 'append' as const } : event,
        )
    const planned = planShadow(normalized, targetSeq)
    if (!planned.ok) return planned
    const expectedSeq = typeof session.seq === 'number' ? session.seq : undefined
    return { ok: true, plan: planned.plan, expectedSeq }
  }

  /** 真的重跑：让 controller 用新文本触发一次生成。 */
  const promptSession = async (sessionId: string, text: string): Promise<{ ok: boolean; reason?: string }> => {
    const controller = safeGet<{ prompt?: (...args: unknown[]) => unknown }>(ctx, 'sessionController')
    if (!controller || typeof controller.prompt !== 'function') {
      return { ok: false, reason: 'sessionController.prompt unavailable' }
    }
    const request = {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }
    const value = await safeCallAsync<{ accepted?: unknown }>(controller, 'prompt', request, new AbortController().signal)
    if (value === undefined) return { ok: false, reason: 'prompt rejected' }
    return { ok: true }
  }

  const adapter: HarnessAdapter = {
    dshVersion: () => version,
    sessionId: () => latest()?.id ?? 'unknown',
    sessionIds: () => (safeCall<LiveSession[]>(sessions, 'list') ?? []).map((session) => session.id),
    epoch: (sessionId) => epochOf(resolve(sessionId)),
    messagesOf: (sessionId) => messagesOfSession(resolve(sessionId)),
    sessionSeq: (sessionId) => {
      const session = resolve(sessionId)
      return session && typeof session.seq === 'number' ? Math.max(0, session.seq - 1) : 0
    },
    // NOTE: this flag is consumed as "the reversible derive-patch strategy is
    // available", and the controller maps it to `adapter.canFork()` — see
    // hooks.ts. It is NOT a claim that the harness exposes a writable derive
    // surface; the name predates the discovery that it does
    // (`ctx.sessions.registerMessageProjection`, still unused here). The fork is
    // what makes a rewind reversible, so fork availability is the honest signal.
    canPatchDeriveMessages: () => false,
    patchDeriveMessages: async () => false,
    // Capability belongs to the harness build, not to whether a chat happens to
    // be open. Probing through a live session (`resolve(sessionId)`) answered
    // `false` whenever none was live — which is the normal state right after
    // boot — and that reading removed `surface-op` from the strategy ladder for
    // the whole process even though the host accepts the append perfectly well.
    // Whether a specific append works is decided at call time, where a real
    // session exists and a rejection is a plain `false`.
    canAppendSurfaceOp: () => Boolean(sessions),
    shadowWindow,
    planShadowFor,
    promptSession,
    appendSurfaceOp: async (op, sessionId) => {
      const session = resolve(sessionId)
      if (!session) return false
      return surfaceFold(session, [op.range])
    },
    canFork: () => typeof safeGet(sessions, 'fork') === 'function',
    // Cached: the probe appends to a throwaway session, and the answer cannot
    // change within one host process.
    probeMessageProjection: () => (projectionVerdict ??= runProjectionProbe(sessions)),
    interruptTurn: async () => false, // v1: turns are short-lived; pending masks the tail anyway
    setDraft: async () => false, // composer access is a client-half concern (slot props)
    getDraft: () => null,
    forkSession: async (boundary, sessionId) => {
      if (typeof sessions.fork !== 'function') return { ok: false, reason: 'fork-unavailable' }
      const session = resolve(sessionId)
      if (!session) return { ok: false, reason: 'no-session' }
      try {
        const child = (sessions.fork as (s: unknown, b: number) => LiveSession)(session, boundary)
        return { ok: true, childId: child.id }
      } catch (error) {
        return { ok: false, reason: String(error) }
      }
    },
    followSession: async () => false, // wired by the client half through its own API
    /**
     * Commands register on the `commands` service. The registry wants a
     * definition object with a discovery description, and its handler answers
     * `{ kind, text }` — so the plain reply string from `commands.ts` is
     * wrapped here, keeping the formatters harness-agnostic.
     */
    registerCommand: (spec, registry) => {
      const commands = asRecord(registry) ?? readService(ctx, 'commands')
      const register = commands?.register as ((definition: unknown) => unknown) | undefined
      if (typeof register !== 'function') {
        notes.push(`no command registry; /${spec.name} unavailable`)
        return
      }
      try {
        register.call(commands, {
          name: spec.name,
          description: spec.description,
          recordInput: false,
          handler: async (invocation: unknown) => {
            const rawInput = asRecord(invocation)?.rawInput
            const text = await spec.handler(typeof rawInput === 'string' ? rawInput : '')
            return { kind: 'success' as const, text }
          },
        })
      } catch {
        notes.push(`command registration failed for /${spec.name}`)
      }
    },
  }

  notes.push(`bound ctx.sessions (sessions=${(safeCall<LiveSession[]>(sessions, 'list') ?? []).length})`)
  return {
    bound: true,
    adapter,
    notes,
    sessions,
    onSessionEvent: null,
    onEvent: typeof safeGet(ctx, 'on') === 'function' ? (event, handler) => safeCall(ctx, 'on', event, handler) : null,
  }
}

/** Config-derived knobs the adapter layer needs to know about. */
export function resolveStrategyPreference(config: PluginConfig): 'auto' | PluginConfig['strategy'] {
  return config.strategy ?? 'auto'
}

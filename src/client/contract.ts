// Wire contract between the two halves.
//
// Same-origin only: the harness does not expose __DSH_API_BASE__, so the prefix
// is a single constant that a profile may override. Types here mirror the host
// responses; keep them in sync with src/host/hooks.ts SessionView.

import type { Capability, HiddenRange, HistoryEntry, PendingState, Strategy, UndoGrade } from '../core/types.js'
import type { ImpactPlan, RewindCandidate } from '../core/types.js'

export const API_PREFIX = '/api/dsh-rewind-pro'

export interface SessionView {
  version: number
  sessionId: string
  ranges: HiddenRange[]
  pending: PendingState | null
  history: HistoryEntry[]
  capability: Capability
  epoch: string
}

export interface UndoResponse {
  grade: UndoGrade['grade']
  applied: boolean
  reason?: string
  divergentTurns?: number
  notice?: string
  state: SessionView
}

export interface PlanResponse {
  impact: ImpactPlan
}

export interface CandidatesResponse {
  candidates: RewindCandidate[]
}

export interface SyncResponse {
  adopted: boolean
  version: number
}

export type Query = Record<string, string | number | undefined>

export function apiPath(endpoint: string, query: Query = {}, prefix: string = API_PREFIX): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    search.set(key, String(value))
  }
  const suffix = search.toString()
  return `${prefix}${endpoint}${suffix ? `?${suffix}` : ''}`
}

export function eventsPath(sessionId: string, prefix: string = API_PREFIX): string {
  return apiPath('/events', { sessionId }, prefix)
}

export interface SseMessage {
  event: string
  data: unknown
}

/**
 * Parse one SSE chunk. Heartbeats (`: ping`) yield nothing and malformed JSON
 * is skipped rather than thrown: a bad frame must not kill the stream.
 */
export function parseSseChunk(chunk: string): SseMessage[] {
  const out: SseMessage[] = []
  for (const frame of chunk.split('\n\n')) {
    if (!frame.trim()) continue
    let event = 'message'
    const dataLines: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) continue
    try {
      out.push({ event, data: JSON.parse(dataLines.join('\n')) })
    } catch {
      /* ignore unparsable frame */
    }
  }
  return out
}

/** POST helper that never throws: callers get a status instead. */
export async function postJson<T>(
  endpoint: string,
  body: unknown,
  options: { prefix?: string; fetch?: typeof fetch } = {},
): Promise<{ ok: boolean; status: number; data?: T }> {
  const doFetch = options.fetch ?? fetch
  try {
    const response = await doFetch(apiPath(endpoint, {}, options.prefix ?? API_PREFIX), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    if (!response.ok) {
      // 失败时也把响应体读出来：宿主会带原因（例如 `stale: expected seq 5`）。
      // 「关掉 + 什么都不说」正是用户以为插件坏掉的原因。
      let data: T | undefined
      try {
        data = (await response.json()) as T
      } catch {
        data = undefined
      }
      return { ok: false, status: response.status, data }
    }
    return { ok: true, status: response.status, data: (await response.json()) as T }
  } catch {
    return { ok: false, status: 0 }
  }
}

export type { Capability, HiddenRange, HistoryEntry, PendingState, Strategy }

/**
 * 把「分页重跑」的失败翻译成一句**看得懂、也知道下一步**的话。
 *
 * 最要紧的是 404：它意味着宿主那一半还是旧模块（插件宿主模块被进程按 id 持有，
 * 卸载再挂载不会重新 import），只能重启 `dsh web`。原样丢一句 "HTTP 404"
 * 用户既不知道发生了什么，也不知道要做什么。
 */
export function branchFailureReason(status: number, error?: string): string {
  const detail = typeof error === 'string' && error.trim() !== '' ? error.trim() : ''
  if (status === 404) {
    return '宿主那一半还没重新加载，这一步**没有生效**：请重启 dsh web（关掉再启动）后重试。'
  }
  if (status === 0) {
    return '连不上宿主（网络或服务未启动），这一步没有生效。'
  }
  if (detail !== '') {
    return status === 400 || status === 409
      ? `宿主拒绝了这次分页重跑：${detail}`
      : `宿主出错了（HTTP ${String(status)}）：${detail}`
  }
  return `宿主拒绝了这次分页重跑（HTTP ${String(status)}）。`
}

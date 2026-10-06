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
    if (!response.ok) return { ok: false, status: response.status }
    return { ok: true, status: response.status, data: (await response.json()) as T }
  } catch {
    return { ok: false, status: 0 }
  }
}

export type { Capability, HiddenRange, HistoryEntry, PendingState, Strategy }

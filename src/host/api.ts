// HTTP + SSE surface for the client half.
//
// Transport-agnostic on purpose: `route()` is a pure-ish function so it can be
// tested without a socket, and `attach()` is the only place that knows about
// node's http. Nothing here throws into the host: every failure is a status
// code with a JSON body.

import { sanitizeSessionId } from '../core/ledger-store.js'
import type { LedgerState, PluginConfig } from '../core/types.js'
import type { RewindController } from './hooks.js'

export const DEFAULT_PREFIX = '/api/dsh-rewind-pro'

export interface ApiRequest {
  method: string
  path: string
  query: URLSearchParams
  body?: unknown
}

export interface ApiResponse {
  status: number
  body?: unknown
  /** Set for the SSE endpoint; `attach` streams it, `route` just reports it. */
  sse?: boolean
}

export type Subscriber = (event: string, data: unknown) => void

export interface RewindApi {
  prefix: string
  route: (request: ApiRequest) => Promise<ApiResponse>
  subscribe: (sessionId: string, send: Subscriber) => () => void
  attach: (server: { on: (event: string, handler: (...args: never[]) => void) => void }) => void
}

export interface ApiDeps {
  controller: RewindController
  config: PluginConfig
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body })

const bodyRecord = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}

/** Session ids reach the filesystem: refuse anything that is not plain. */
const safeSessionId = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  const cleaned = sanitizeSessionId(value)
  return cleaned === value ? value : null
}

export function createRewindApi(deps: ApiDeps): RewindApi {
  const { controller } = deps
  const prefix = deps.config.apiPrefix ?? DEFAULT_PREFIX
  const subscribers = new Map<string, Set<Subscriber>>()

  const publish = (sessionId: string): void => {
    const listeners = subscribers.get(sessionId)
    if (!listeners || listeners.size === 0) return
    const state = controller.state(sessionId)
    for (const send of listeners) {
      try {
        send('state', state)
      } catch {
        /* a dead tab must not break the others */
      }
    }
  }

  const route = async (request: ApiRequest): Promise<ApiResponse> => {
    const url = new URL(request.path, 'http://localhost')
    const path = url.pathname
    const query = url.searchParams

    if (!path.startsWith(prefix)) return json(404, { error: 'not-found' })
    const rest = path.slice(prefix.length).replace(/\/+$/, '')
    if (rest.length === 0) return json(200, { ok: true, plugin: 'dsh-rewind-pro' })

    const body = bodyRecord(request.body)
    const sessionId = safeSessionId(query.get('sessionId') ?? body.sessionId)
    if (rest !== '/health' && !sessionId) return json(400, { error: 'bad-session-id' })

    // Every branch below can assume a validated sessionId.
    const sid = sessionId as string

    switch (`${request.method} ${rest}`) {
      case 'GET /health':
        return json(200, { ok: true, capability: controller.capability() })

      case 'GET /state':
        return json(200, controller.state(sid))

      case 'GET /candidates':
        return json(200, { candidates: controller.candidates(sid) })

      case 'GET /plan': {
        const targetSeq = Number(query.get('targetSeq'))
        if (!Number.isFinite(targetSeq)) return json(400, { error: 'bad-target' })
        const impact = controller.impact(sid, targetSeq)
        return impact ? json(200, { impact }) : json(404, { error: 'target-not-found' })
      }

      case 'POST /mark': {
        const targetSeq = Number(body.targetSeq)
        if (!Number.isFinite(targetSeq)) return json(400, { error: 'bad-target' })
        const result = await controller.mark({ sessionId: sid, targetSeq })
        publish(sid)
        return result.ok ? json(200, controller.state(sid)) : json(409, { error: result.reason })
      }

      case 'POST /cancel': {
        const result = await controller.cancel({ sessionId: sid })
        publish(sid)
        return result.ok ? json(200, controller.state(sid)) : json(409, { error: result.reason })
      }

      case 'POST /commit': {
        const result = await controller.commit({ sessionId: sid })
        publish(sid)
        return result.ok ? json(200, controller.state(sid)) : json(409, { error: result.reason })
      }

      case 'POST /undo': {
        const result = await controller.undo({
          sessionId: sid,
          ...(typeof body.opId === 'string' ? { opId: body.opId } : {}),
          ...(body.force === true ? { force: true } : {}),
        })
        publish(sid)
        return json(200, { ...result, state: controller.state(sid) })
      }

      case 'POST /jump': {
        const toIndex = Number(body.toIndex)
        if (!Number.isInteger(toIndex)) return json(400, { error: 'bad-index' })
        const result = await controller.jump({ sessionId: sid, toIndex })
        publish(sid)
        return result.ok ? json(200, controller.state(sid)) : json(409, { error: result.reason })
      }

      case 'POST /sync': {
        const remote = bodyRecord(body.state) as unknown as LedgerState
        if (typeof remote?.version !== 'number' || !Array.isArray(remote.ops)) {
          return json(400, { error: 'bad-state' })
        }
        const current = controller.state(sid)
        // Monotonic version + echo suppression: older or own writes are dropped.
        const adopted = remote.version > current.version && (body.originClientId as string) !== 'host'
        return json(200, { adopted, version: current.version })
      }

      case 'GET /events':
        return { status: 200, sse: true }

      default:
        return json(404, { error: 'not-found' })
    }
  }

  return {
    prefix,

    route,

    subscribe(sessionId, send) {
      const set = subscribers.get(sessionId) ?? new Set<Subscriber>()
      set.add(send)
      subscribers.set(sessionId, set)
      return () => {
        set.delete(send)
        if (set.size === 0) subscribers.delete(sessionId)
      }
    },

    attach(server) {
      server.on('request', (...args: never[]) => {
        const [req, res] = args as unknown as [
          { method?: string; url?: string; on: (event: string, cb: (chunk?: unknown) => void) => void },
          {
            writeHead: (status: number, headers?: Record<string, string>) => void
            write: (chunk: string) => void
            end: (chunk?: string) => void
          },
        ]
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const isSse = url.pathname === `${prefix}/events`

          if (isSse) {
            const sessionId = safeSessionId(url.searchParams.get('sessionId'))
            if (!sessionId) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'bad-session-id' }))
              return
            }
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            })
            const send: Subscriber = (event, data) => {
              res.write(`event: ${event}\n`)
              res.write(`data: ${JSON.stringify(data)}\n\n`)
            }
            const unsubscribe = this.subscribe(sessionId, send)
            const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
            ;(req as unknown as { on: (event: string, cb: () => void) => void }).on('close', () => {
              clearInterval(heartbeat)
              unsubscribe()
            })
            return
          }

          const chunks: Buffer[] = []
          req.on('data', (chunk) => chunks.push(Buffer.from(String(chunk))))
          await new Promise<void>((resolve) => {
            req.on('end', () => resolve())
          })
          const raw = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          try {
            parsed = raw ? JSON.parse(raw) : undefined
          } catch {
            parsed = undefined
          }

          try {
            const response = await route({
              method: req.method ?? 'GET',
              path: req.url ?? '/',
              query: url.searchParams,
              body: parsed,
            })
            res.writeHead(response.status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(response.body ?? {}))
          } catch (error) {
            // Never let a handler error escape into the host process.
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'internal', detail: String(error) }))
          }
        })()
      })
    },
  }
}

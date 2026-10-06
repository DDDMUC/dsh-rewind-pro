// dsh-rewind-pro — host half entry.
//
// Loading rules, learned on the live harness:
//   1. never throw into the host (a rewind plugin must not brick a session)
//   2. declare only services that always exist (`sessions`); everything else
//      binds lazily and degrades (webServer may be absent headless)
//   3. cordis ctx is a strict proxy: EVERY property read is guarded
//   4. `ctx.inject(deps, cb)` hands cb a CHILD CONTEXT, never the service
//      object — the service is read off it as `child.<name>`, and the route is
//      mounted inside `child.effect(...)` so it dies with the child fiber
//   5. the session log is append-only; masking is a view, not a rewrite

import path from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_CONFIG } from './core/types.js'
import type { PluginConfig } from './core/types.js'
import { scanLegacyMarkers, summarizeMigration } from './core/migrate.js'
import { detectAdapter } from './host/adapter.js'
import type { AdapterProbe } from './host/adapter.js'
import { createRewindController } from './host/hooks.js'
import type { RewindController } from './host/hooks.js'
import { createRewindApi, DEFAULT_PREFIX } from './host/api.js'
import { registerCommands } from './host/commands.js'

export const name = 'rewind-pro'

/**
 * Cordis top-level dependency. `sessions` is the one service the plugin core
 * cannot work without; webServer binds lazily through ctx.inject below so a
 * headless boot degrades instead of stalling.
 */
export const inject = ['sessions']

/** Minimal ctx shape we touch; every read is guarded by the adapter probe. */
interface HostContext {
  /**
   * The cordis root CONTEXT (`ctx.root`), NOT a directory. Kept in the shape
   * only so callers may pass it; never joined into a path.
   */
  root?: unknown
  /** The service named in the module `inject` list; the adapter reads it. */
  sessions?: unknown
  /** Per-plugin config bag (`ctx.model.config['rewind-pro']`). */
  model?: unknown
  logger?: { info?: (msg: string, ...args: unknown[]) => void; warn?: (msg: string) => void; error?: (msg: string) => void }
  /** `cb` receives a child context that has the named services injected. */
  inject?: (services: string[], cb: (ctx: unknown) => unknown) => unknown
  /** cordis service read that needs no inject declaration (`strict: false`). */
  get?: (name: string, strict?: boolean) => unknown
  on?: (event: string, handler: (payload: unknown) => void) => void
}

type AnyRecord = Record<string, unknown>

/** cordis throws for properties outside the inject list — never let it escape. */
function safeGet<T = unknown>(holder: unknown, key: string): T | undefined {
  try {
    return (holder as Record<string, T | undefined>)?.[key]
  } catch {
    return undefined
  }
}

const asRecord = (value: unknown): AnyRecord | null =>
  typeof value === 'object' && value !== null ? (value as AnyRecord) : null

/**
 * Read the entry's config.
 *
 * Cordis hands the RESOLVED entry config to `apply` as the second argument
 * (`runtime.callback(this.ctx, this.config)`). Looking only for a ctx-side bag
 * means every profile setting — `workspaceRoot`, `snapshotDir`, `apiPrefix`,
 * `debug`, the feature switches — is silently ignored and the plugin runs on
 * defaults, writing its state to the default DSH home instead of where the
 * profile pointed it. The ctx-side lookup stays as a fallback for hosts that
 * aggregate plugin config onto the context.
 */
export function readConfig(ctx: HostContext, injectedConfig?: unknown): PluginConfig {
  const fromCtx = asRecord(asRecord(safeGet(ctx, 'model'))?.config)?.['rewind-pro']
  const raw = asRecord(injectedConfig) ?? asRecord(fromCtx) ?? {}
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

  return {
    ...DEFAULT_CONFIG,
    strategy: (typeof raw.strategy === 'string' ? raw.strategy : DEFAULT_CONFIG.strategy) as PluginConfig['strategy'],
    snapshot: bool(raw.snapshot, DEFAULT_CONFIG.snapshot),
    trackSubagent: bool(raw.trackSubagent, DEFAULT_CONFIG.trackSubagent),
    maxAnchorGroups: num(raw.maxAnchorGroups, DEFAULT_CONFIG.maxAnchorGroups),
    maxFileBytes: num(raw.maxFileBytes, DEFAULT_CONFIG.maxFileBytes),
    watchPaths: Array.isArray(raw.watchPaths) ? (raw.watchPaths as string[]) : DEFAULT_CONFIG.watchPaths,
    rescueRetention: num(raw.rescueRetention, DEFAULT_CONFIG.rescueRetention),
    ...(typeof raw.stateDir === 'string' ? { stateDir: raw.stateDir } : {}),
    ...(typeof raw.snapshotDir === 'string' ? { snapshotDir: raw.snapshotDir } : {}),
    ...(typeof raw.apiPrefix === 'string' ? { apiPrefix: raw.apiPrefix } : {}),
    ...(typeof raw.workspaceRoot === 'string' ? { workspaceRoot: raw.workspaceRoot } : {}),
    ...(raw.debug === true ? { debug: true } : {}),
  }
}

/**
 * Where the plugin keeps its own state; overridable for tests and profiles.
 *
 * `ctx.root` is a cordis CONTEXT (cordis does `this.root = self`), NOT a base
 * directory: joining it into a path throws ERR_INVALID_ARG_TYPE. That throw
 * used to abort `apply()` before anything was wired at all — no route, no
 * commands, no event listener — which is why the plugin looked installed but
 * did nothing on a real host. Keep the base a real directory.
 */
export function resolvePaths(ctx: HostContext, config: PluginConfig): {
  ledgerDir: string
  snapshotRoot: string
  workspaceRoot: string
} {
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  const base = config.stateDir ?? home
  void ctx
  return {
    ledgerDir: path.join(base, 'rewind-pro', 'ledgers'),
    snapshotRoot: config.snapshotDir ?? path.join(base, 'rewind-pro-snapshots'),
    workspaceRoot: config.workspaceRoot ?? process.cwd(),
  }
}

const WRITE_TOOL_HINTS = ['str_replace_editor', 'create_file', 'write', 'edit', 'save']

/**
 * Wire the session event firehose:
 *   * `tool/call` on a write-shaped tool  -> capture the file BEFORE the write
 *   * `user/message` after a pending mark -> fallback commit (pre-step may
 *     never fire for plugin code; the log itself is the durable signal)
 *
 * The bus declares `'session/event'(session, event)` — TWO positional
 * arguments. Reading them out of a single `{session, event}` bag yields
 * `undefined` for both and the handler silently does nothing, which is how the
 * whole event-driven half (file checkpoints, commit fallback) went dead.
 */
export function bindSessionEvents(
  probe: AdapterProbe,
  controller: RewindController,
  workspaceRoot: string,
): string[] {
  const bound: string[] = []
  if (!probe.onEvent) return bound

  try {
    probe.onEvent('session/event', (sessionArg: unknown, eventArg: unknown) => {
      const session = asRecord(sessionArg)
      const event = asRecord(eventArg)
      if (!session || !event) return
      const sessionId = typeof session.id === 'string' ? session.id : 'unknown'
      const type = event.type
      const data = asRecord(event.data) ?? {}
      const seq = typeof event.seq === 'number' ? event.seq : 0

      if (type === 'tool/call') {
        const toolName = String(data.name ?? '')
        if (!WRITE_TOOL_HINTS.some((hint) => toolName.toLowerCase().includes(hint))) return
        let rel: string | undefined
        try {
          const args = JSON.parse(String(data.arguments ?? '{}')) as AnyRecord
          const candidate = args.path ?? args.file_path ?? args.abs_path ?? args.filename
          if (typeof candidate === 'string') rel = candidate
        } catch {
          return
        }
        if (!rel) return
        const absPath = path.isAbsolute(rel) ? rel : path.resolve(workspaceRoot, rel)
        const origin = asRecord(safeGet(session, 'header'))?.origin
        void controller
          .handleBeforeWrite({
            sessionId,
            absPath,
            turnSeq: seq,
            ...(typeof origin === 'string' ? { agentId: origin } : {}),
          })
          .catch(() => undefined)
        return
      }

      if (type === 'user/message') {
        void controller
          .handleSessionEvent({ sessionId, type: 'message', payload: { seq, role: 'user' } })
          .catch(() => undefined)
      }
    })
    bound.push('session/event')
  } catch {
    /* event bus unavailable */
  }
  return bound
}

/** Dry-run legacy marker scan: adopt what we understand, never rewrite it. */
async function migrateLegacyMarkers(config: PluginConfig): Promise<void> {
  if (!config.debug && !process.env.DSH_REWIND_MIGRATE) return
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  const { readdir, readFile } = await import('node:fs/promises')
  let files: Array<{ path: string; content: string }> = []
  try {
    const names = await readdir(path.join(home, 'rewind'))
    files = await Promise.all(
      names
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => ({
          path: path.join(home, 'rewind', n),
          content: await readFile(path.join(home, 'rewind', n), 'utf8'),
        })),
    )
  } catch {
    return
  }
  const summary = summarizeMigration(scanLegacyMarkers(files))
  if (summary.badge) console.log(`[rewind-pro] ${summary.badge} (dry run)`)
}

export function apply(ctx: HostContext, injectedConfig?: unknown): void {
  const log = ctx.logger ?? {}

  try {
    const config = readConfig(ctx, injectedConfig)
    const paths = resolvePaths(ctx, config)
    const probe = detectAdapter(ctx)
    if (config.debug) log.info?.(`[rewind-pro] adapter bound=${probe.bound} ${probe.notes.join('; ')}`)

    const controller = createRewindController({
      adapter: probe.adapter,
      ledgerDir: paths.ledgerDir,
      snapshotRoot: paths.snapshotRoot,
      workspaceRoot: paths.workspaceRoot,
      config,
    })

    const api = createRewindApi({ controller, config })
    const bound = bindSessionEvents(probe, controller, paths.workspaceRoot)
    if (config.debug && bound.length > 0) log.info?.(`[rewind-pro] events bound: ${bound.join(', ')}`)
    void migrateLegacyMarkers(config)

    // Lazy service binds. The loader applies entries CONCURRENTLY, so a service
    // read at apply time may legitimately miss a provider that is still
    // loading; binding through ctx.inject lands whenever the service arrives.
    if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (child) => {
        registerCommands(probe.adapter, controller, safeGet(child, 'commands'))
      })

      ctx.inject(['webServer'], (child) => {
        // The callback argument is the injected CHILD CONTEXT, not the service:
        // on a strict cordis proxy, reading `.register` off the context itself
        // throws ("cannot get property \"register\" without inject"), which is
        // how this route silently never mounted before.
        const webServer = asRecord(safeGet(child, 'webServer'))
        const register = webServer?.register as
          | ((route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => unknown)
          | undefined
        if (typeof register !== 'function') return

        const prefix = config.apiPrefix ?? DEFAULT_PREFIX
        const mount = (): (() => void) => {
          const dispose = register.call(webServer, {
            kind: 'prefix',
            path: prefix,
            handler: (req, res) => handleHttp(api, prefix, req, res),
          })
          if (config.debug) log.info?.(`[rewind-pro] HTTP surface mounted at ${prefix}`)
          return typeof dispose === 'function' ? (dispose as () => void) : () => undefined
        }

        // Register as a child-fiber effect so the route unregisters with it.
        const effect = safeGet<(fn: () => unknown) => unknown>(child, 'effect')
        if (typeof effect === 'function') effect.call(child, mount)
        else mount()
      })
    } else {
      // No dynamic inject on this context (headless / older ctx): register now
      // and let the adapter fall back to its own service read.
      registerCommands(probe.adapter, controller)
      if (config.debug) log.info?.('[rewind-pro] no inject() on ctx; HTTP surface skipped')
    }
  } catch (error) {
    // Last line of defence: a broken plugin must never break the harness.
    log.error?.(`[rewind-pro] failed to start: ${String(error)}`)
  }
}

/** Per-request handler: SSE for /events, JSON for everything else. */
async function handleHttp(
  api: ReturnType<typeof createRewindApi>,
  prefix: string,
  rawReq: unknown,
  rawRes: unknown,
): Promise<void> {
  const req = rawReq as { method?: string; url?: string; on: (event: string, cb: (chunk?: unknown) => void) => void }
  const res = rawRes as {
    writeHead: (status: number, headers?: Record<string, string>) => void
    write: (chunk: string) => void
    end: (chunk?: string) => void
    on?: (event: string, cb: () => void) => void
  }

  try {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === `${prefix}/events`) {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\n`)
        res.write(`data: ${JSON.stringify(data)}\n\n`)
      }
      const unsubscribe = api.subscribe(sessionId, send)
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
      res.on?.('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
      })
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(String(chunk))))
    await new Promise<void>((resolve) => req.on('end', () => resolve()))
    const raw = Buffer.concat(chunks).toString('utf8')
    let parsed: unknown
    try {
      parsed = raw ? JSON.parse(raw) : undefined
    } catch {
      parsed = undefined
    }

    const response = await api.route({
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      query: url.searchParams,
      body: parsed,
    })
    res.writeHead(response.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(response.body ?? {}))
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'internal', detail: String(error) }))
  }
}

// NOTE: deliberately NO `export default`. Cordis's loader normalizes export
// shapes with `unwrapExports`, which prefers `default` and then bails on
// anything without `__esModule`:
//
//     exports = exports.default ?? exports
//     if (!exports.__esModule) return exports
//
// A `default` of the bare `apply` function therefore makes the loader mount
// THAT FUNCTION ALONE — silently dropping `inject` and `name` from the same
// module namespace. Without `inject: ['sessions']` the plugin's ctx cannot read
// `ctx.sessions`, the adapter degrades to its null form, and the whole plugin
// loads "successfully" while doing nothing at all.
// Ships as `export { apply, inject, name, ... }` only.

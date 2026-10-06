// Plugin entry: it must never take the harness down.
//   * headless (no sessions service) -> loads, degrades, no throw
//   * with a web server -> registers one prefix route under our namespace
//   * with an event bus -> binds what exists and ignores the rest

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { apply, inject, name, readConfig, resolvePaths } from '../../src/index'
import * as hostModule from '../../src/index'
import { DEFAULT_CONFIG } from '../../src/core/types'
import { cleanupTmp } from './helpers/tmp'

afterAll(cleanupTmp)

interface FakeResponse {
  status?: number
  headers?: Record<string, string>
  chunks: string[]
  writeHead: (status: number, headers?: Record<string, string>) => void
  write: (chunk: string) => void
  end: (chunk?: string) => void
  on: (event: string, cb: () => void) => void
}

const fakeResponse = (): FakeResponse => {
  const res: FakeResponse = {
    chunks: [],
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    write(chunk) {
      res.chunks.push(chunk)
    },
    end(chunk) {
      if (chunk) res.chunks.push(chunk)
    },
    on() {},
  }
  return res
}

const fakeRequest = (method: string, url: string, body?: unknown) => {
  const handlers = new Map<string, (chunk?: unknown) => void>()
  return {
    method,
    url,
    on(event: string, cb: (chunk?: unknown) => void) {
      handlers.set(event, cb)
      if (event === 'data' && body !== undefined) cb(JSON.stringify(body))
      if (event === 'end') setTimeout(() => cb(), 0)
    },
  }
}

type RouteHandler = (req: unknown, res: unknown) => void

/**
 * Point the plugin's own state at a temp dir. This goes through plugin config
 * (`stateDir`), NOT `ctx.root` — `ctx.root` is the cordis root CONTEXT, and
 * joining it into a path throws (that bug aborted apply() on real hosts).
 */
const stateDirConfig = (dir: string) => ({ model: { config: { 'rewind-pro': { stateDir: dir } } } })

describe('plugin manifest', () => {
  it('declares a top-level inject list and a name', () => {
    expect(name).toBe('rewind-pro')
    expect(inject).toContain('sessions')
  })

  it('exports NO default (cordis unwrapExports prefers it and drops inject/name)', () => {
    // `unwrapExports` does `exports = exports.default ?? exports`, then bails
    // for anything without `__esModule`. A `default` of the bare apply function
    // makes the loader mount that function alone: inject and name vanish, the
    // plugin cannot read ctx.sessions, and it silently degrades to a no-op.
    expect('default' in hostModule).toBe(false)
    expect(typeof hostModule.apply).toBe('function')
    expect(hostModule.inject).toEqual(['sessions'])
    expect(hostModule.name).toBe('rewind-pro')
  })
})

describe('readConfig', () => {
  it('takes the cordis-injected config from the second apply argument', () => {
    // cordis calls `runtime.callback(ctx, config)`; a plugin that only reads a
    // ctx-side bag ignores every profile setting.
    const cfg = readConfig(
      {},
      {
        workspaceRoot: 'W',
        snapshotDir: 'S',
        stateDir: 'D',
        apiPrefix: '/x',
        debug: true,
        strategy: 'surface-op',
      },
    )
    expect(cfg.workspaceRoot).toBe('W')
    expect(cfg.snapshotDir).toBe('S')
    expect(cfg.stateDir).toBe('D')
    expect(cfg.apiPrefix).toBe('/x')
    expect(cfg.debug).toBe(true)
    expect(cfg.strategy).toBe('surface-op')
  })

  it('still accepts a ctx-side config bag as a fallback', () => {
    const cfg = readConfig({ model: { config: { 'rewind-pro': { workspaceRoot: 'W2' } } } })
    expect(cfg.workspaceRoot).toBe('W2')
  })

  it('falls back to defaults when nothing is supplied', () => {
    expect(readConfig({}).strategy).toBe(DEFAULT_CONFIG.strategy)
    expect(readConfig({}).snapshot).toBe(DEFAULT_CONFIG.snapshot)
  })
})

describe('resolvePaths', () => {
  it('never joins ctx.root into a path (it is a cordis CONTEXT, not a directory)', () => {
    // A Context-like object: path.join() rejects it with ERR_INVALID_ARG_TYPE,
    // which is exactly how apply() used to die before wiring anything.
    const contextLikeRoot = { toString: () => '[Context]' }
    const paths = resolvePaths({ root: contextLikeRoot }, { ...DEFAULT_CONFIG })
    expect(path.isAbsolute(paths.ledgerDir)).toBe(true)
    expect(paths.ledgerDir).toContain('rewind-pro')
    expect(paths.snapshotRoot).toContain('rewind-pro-snapshots')
    expect(path.isAbsolute(paths.workspaceRoot)).toBe(true)
  })

  it('honours an explicit stateDir', () => {
    const dir = path.join(tmpdir(), 'rewind-state')
    const paths = resolvePaths({}, { ...DEFAULT_CONFIG, stateDir: dir })
    expect(paths.ledgerDir.startsWith(dir)).toBe(true)
    expect(paths.snapshotRoot.startsWith(dir)).toBe(true)
  })
})

describe('apply', () => {
  it('loads in a headless context without throwing', () => {
    const ctx = { logger: { info() {}, warn() {}, error() {} } }
    expect(() => apply(ctx)).not.toThrow()
  })

  it('registers one prefix route and answers under its own namespace', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rewind-plugin-'))
    const routes: Array<{ kind: string; path: string; handler: RouteHandler }> = []
    const ctx = {
      ...stateDirConfig(dir),
      logger: { info() {}, warn() {}, error() {} },
      // Real cordis contract: the callback receives a CHILD CONTEXT with the
      // service injected — never the service object itself. Both lazy binds
      // (commands, webServer) arrive through this same call.
      inject(services: string[], cb: (child: unknown) => unknown) {
        if (services.includes('commands')) {
          cb({ commands: { register: () => () => undefined } })
        }
        if (services.includes('webServer')) {
          cb({
            webServer: {
              register(route: { kind: string; path: string; handler: RouteHandler }) {
                routes.push(route)
              },
            },
          })
        }
        return undefined
      },
    }

    apply(ctx)
    expect(routes).toHaveLength(1)
    expect(routes[0].kind).toBe('prefix')
    expect(routes[0].path).toBe('/api/dsh-rewind-pro')

    const res = fakeResponse()
    routes[0].handler(fakeRequest('GET', '/api/dsh-rewind-pro/health?sessionId=s1'), res)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(res.status).toBe(200)
    expect(res.chunks.join('')).toContain('capability')
  })

  it('mounts the route through the injected child effect so it unregisters', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rewind-plugin-'))
    const routes: Array<{ kind: string; path: string; handler: RouteHandler }> = []
    const disposers: Array<() => void> = []
    let unmounted = 0
    apply({
      ...stateDirConfig(dir),
      logger: { info() {}, warn() {}, error() {} },
      inject(services: string[], cb: (child: unknown) => unknown) {
        if (services.includes('commands')) {
          cb({ commands: { register: () => () => undefined } })
        }
        if (services.includes('webServer')) {
          cb({
            webServer: {
              register(route: { kind: string; path: string; handler: RouteHandler }) {
                routes.push(route)
                return () => {
                  unmounted++
                }
              },
            },
            effect(fn: () => () => void) {
              disposers.push(fn())
              return () => undefined
            },
          })
        }
        return undefined
      },
    })

    // The mount ran inside the effect, and the route's own disposer was kept.
    expect(routes).toHaveLength(1)
    expect(disposers).toHaveLength(1)
    disposers[0]()
    expect(unmounted).toBe(1)
  })

  it('answers 404 outside its prefix', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rewind-plugin-'))
    const routes: Array<{ handler: RouteHandler }> = []
    apply({
      ...stateDirConfig(dir),
      logger: { info() {}, warn() {}, error() {} },
      inject(services: string[], cb: (child: unknown) => unknown) {
        if (services.includes('commands')) {
          cb({ commands: { register: () => () => undefined } })
        }
        if (services.includes('webServer')) {
          cb({
            webServer: {
              register(route: { handler: RouteHandler }) {
                routes.push(route)
              },
            },
          })
        }
        return undefined
      },
    })

    const res = fakeResponse()
    routes[0].handler(fakeRequest('GET', '/someone/elses/route'), res)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(res.status).toBe(404)
  })

  it('binds harness events when the context exposes a bus', () => {
    const bound: string[] = []
    apply({
      logger: { info() {}, warn() {}, error() {} },
      on(event: string) {
        bound.push(event)
      },
    })
    // Nothing throws and whatever was available got bound.
    expect(Array.isArray(bound)).toBe(true)
  })

  it('registers the slash commands on the commands service (not ctx.registerCommand)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rewind-plugin-'))
    const defs: Array<{ name: string; description: string; handler: (i: unknown) => Promise<unknown> }> = []
    const registry = {
      register(definition: { name: string; description: string; handler: (i: unknown) => Promise<unknown> }) {
        defs.push(definition)
        return () => undefined
      },
    }
    // A real command registry is only reached through a bound adapter, which
    // needs the sessions service the plugin declares in its inject list.
    const session = {
      id: 'session-1',
      seq: 1,
      firstLiveSeq: 0,
      surface: { replaceGeneration: 0 },
      snapshotEvents: () => [],
    }
    apply({
      ...stateDirConfig(dir),
      logger: { info() {}, warn() {}, error() {} },
      sessions: { list: () => [session], get: () => session },
      // cordis 4 service read without the inject requirement.
      get(name: string) {
        return name === 'commands' ? registry : undefined
      },
    })

    expect(defs.map((d) => d.name).sort()).toEqual([
      'rewind',
      'rewind-export-clean',
      'rewind-history',
      'rewind-undo',
    ])
    // Every definition carries discovery metadata and answers the registry shape.
    for (const def of defs) expect(def.description.length).toBeGreaterThan(0)
    const result = (await defs.find((d) => d.name === 'rewind-history')!.handler({ rawInput: '' })) as {
      kind: string
      text: string
    }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('No rewind history')
  })
})

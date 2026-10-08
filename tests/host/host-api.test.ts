// HTTP surface: one prefix, JSON in/out, SSE for cross-tab sync. The router is
// transport-agnostic so it can be tested without a socket, and it must never
// throw into the host: every failure is a JSON status.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createRewindApi } from '../../src/host/api'
import { createRewindController } from '../../src/host/hooks'
import { DEFAULT_CONFIG } from '../../src/core/types'
import { cleanupTmp } from './helpers/tmp'
import { conversation, FakeHost } from './helpers/fake-host'

afterAll(cleanupTmp)

const dirs: string[] = []
const freshDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rewind-api-'))
  dirs.push(dir)
  return dir
}

let host: FakeHost
let api: ReturnType<typeof createRewindApi>

const call = (method: string, pathname: string, body?: unknown) =>
  api.route({ method, path: pathname, query: new URLSearchParams(), body })

beforeEach(async () => {
  host = new FakeHost({ messages: conversation() })
  api = createRewindApi({
    controller: createRewindController({
      adapter: host,
      ledgerDir: await freshDir(),
      snapshotRoot: await freshDir(),
      workspaceRoot: await freshDir(),
      config: { ...DEFAULT_CONFIG, apiPrefix: '/api/dsh-rewind-pro' },
      now: () => 1000,
    }),
    config: { ...DEFAULT_CONFIG, apiPrefix: '/api/dsh-rewind-pro' },
  })
})

describe('routing', () => {
  it('exposes the documented prefix and 404s everything else', async () => {
    expect(api.prefix).toBe('/api/dsh-rewind-pro')
    expect((await call('GET', '/nope')).status).toBe(404)
  })

  it('rejects an unsafe session id instead of touching the disk', async () => {
    const res = await call('GET', '/api/dsh-rewind-pro/state?sessionId=../../etc')
    expect(res.status).toBe(400)
  })
})

describe('POST /branch/apply（分页重跑）', () => {
  it('遮蔽之后用改写后的文本重新提示，两步都落到适配器上', async () => {
    const res = await call('POST', '/api/dsh-rewind-pro/branch/apply', {
      sessionId: 'session-1',
      targetSeq: 3,
      text: '改写后的提示词',
    })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, shadowed: true })
    expect(host.prompts[0]).toMatchObject({ sessionId: 'session-1', text: '改写后的提示词' })
    expect(host.shadows).toHaveLength(1)
  })

  it('空文本被拒 —— 绝不能把空提示词送进模型', async () => {
    const res = await call('POST', '/api/dsh-rewind-pro/branch/apply', {
      sessionId: 'session-1',
      targetSeq: 3,
      text: '   ',
    })

    expect(res.status).toBe(400)
    expect(host.prompts).toHaveLength(0)
    expect(host.shadows).toHaveLength(0)
  })

  it('重跑被拒时返回 shadowed:true —— 日志确实已经变了，调用方必须知道', async () => {
    host.promptVerdict = { ok: false, reason: 'sessionController.prompt unavailable' }

    const res = await call('POST', '/api/dsh-rewind-pro/branch/apply', {
      sessionId: 'session-1',
      targetSeq: 3,
      text: '改写后的提示词',
    })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ shadowed: true, error: expect.stringContaining('sessionController') as unknown as string })
  })

  it('规划不出来时不动日志，也不重跑', async () => {
    host.planVerdict = { ok: false, reason: 'seq 9 is not a surface node' }

    const res = await call('POST', '/api/dsh-rewind-pro/branch/apply', {
      sessionId: 'session-1',
      targetSeq: 9,
      text: '改写后的提示词',
    })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ shadowed: false })
    expect(host.shadows).toHaveLength(0)
    expect(host.prompts).toHaveLength(0)
  })
})

describe('state', () => {
  it('reports pending, ranges, history and capability', async () => {
    const res = await call('POST', '/api/dsh-rewind-pro/mark', { sessionId: 'session-1', targetSeq: 3 })
    expect(res.status).toBe(200)

    const state = await call('GET', '/api/dsh-rewind-pro/state?sessionId=session-1')
    expect(state.status).toBe(200)
    const body = state.body as { pending: { targetSeq: number } | null; capability: { chosen: string } }
    expect(body.pending?.targetSeq).toBe(3)
    expect(body.capability.chosen).toBe('derive-patch')
  })

  it('bumps the version so a second tab can short-circuit', async () => {
    const before = (await call('GET', '/api/dsh-rewind-pro/state?sessionId=session-1')).body as { version: number }
    await call('POST', '/api/dsh-rewind-pro/mark', { sessionId: 'session-1', targetSeq: 3 })
    const after = (await call('GET', '/api/dsh-rewind-pro/state?sessionId=session-1')).body as { version: number }
    expect(after.version).toBeGreaterThan(before.version)
  })
})

describe('two-phase endpoints', () => {
  it('mark -> cancel leaves no hidden range', async () => {
    await call('POST', '/api/dsh-rewind-pro/mark', { sessionId: 'session-1', targetSeq: 3 })
    const res = await call('POST', '/api/dsh-rewind-pro/cancel', { sessionId: 'session-1' })
    expect(res.status).toBe(200)
    const state = (await call('GET', '/api/dsh-rewind-pro/state?sessionId=session-1')).body as {
      ranges: unknown[]
      pending: unknown
    }
    expect(state.ranges).toEqual([])
    expect(state.pending).toBeNull()
  })

  it('mark -> commit records the range', async () => {
    await call('POST', '/api/dsh-rewind-pro/mark', { sessionId: 'session-1', targetSeq: 3 })
    const res = await call('POST', '/api/dsh-rewind-pro/commit', { sessionId: 'session-1' })
    expect(res.status).toBe(200)
    const state = (await call('GET', '/api/dsh-rewind-pro/state?sessionId=session-1')).body as { ranges: unknown[] }
    expect(state.ranges).toEqual([{ start: 3, end: 4 }])
  })

  it('undo grades and applies in one call', async () => {
    await call('POST', '/api/dsh-rewind-pro/mark', { sessionId: 'session-1', targetSeq: 3 })
    await call('POST', '/api/dsh-rewind-pro/commit', { sessionId: 'session-1' })
    const res = await call('POST', '/api/dsh-rewind-pro/undo', { sessionId: 'session-1' })
    expect(res.status).toBe(200)
    expect((res.body as { grade: string }).grade).toBe('clean')
  })

  it('jump rewinds the ledger to an earlier op', async () => {
    await call('POST', '/api/dsh-rewind-pro/mark', { sessionId: 'session-1', targetSeq: 3 })
    await call('POST', '/api/dsh-rewind-pro/commit', { sessionId: 'session-1' })
    const res = await call('POST', '/api/dsh-rewind-pro/jump', { sessionId: 'session-1', toIndex: 0 })
    expect(res.status).toBe(200)
    expect(host.deriveRanges).toEqual([])
  })
})

describe('planning endpoints', () => {
  it('lists rewind candidates', async () => {
    const res = await call('GET', '/api/dsh-rewind-pro/candidates?sessionId=session-1')
    expect(res.status).toBe(200)
    const body = res.body as { candidates: Array<{ seq: number }> }
    expect(body.candidates.map((c) => c.seq)).toEqual([3, 1])
  })

  it('previews the impact of a target', async () => {
    const res = await call('GET', '/api/dsh-rewind-pro/plan?sessionId=session-1&targetSeq=3')
    expect(res.status).toBe(200)
    const body = res.body as { impact: { turns: unknown[]; shellCalls: number } }
    expect(body.impact.turns).toHaveLength(2)
    expect(body.impact.shellCalls).toBe(1)
  })
})

describe('sync and SSE', () => {
  it('drops a remote state that is not newer', async () => {
    const res = await call('POST', '/api/dsh-rewind-pro/sync', {
      sessionId: 'session-1',
      state: { version: 0, ops: [] },
      originClientId: 'tab-b',
    })
    expect(res.status).toBe(200)
    expect((res.body as { adopted: boolean }).adopted).toBe(false)
  })

  it('fans ledger changes out to subscribers', async () => {
    const seen: unknown[] = []
    const unsubscribe = api.subscribe('session-1', (_event, data) => seen.push(data))
    await call('POST', '/api/dsh-rewind-pro/mark', { sessionId: 'session-1', targetSeq: 3 })
    unsubscribe()
    expect(seen.length).toBeGreaterThan(0)
  })

  it('stops sending after unsubscribe', async () => {
    const seen: unknown[] = []
    const unsubscribe = api.subscribe('session-1', (_event, data) => seen.push(data))
    unsubscribe()
    await call('POST', '/api/dsh-rewind-pro/mark', { sessionId: 'session-1', targetSeq: 3 })
    expect(seen).toEqual([])
  })
})

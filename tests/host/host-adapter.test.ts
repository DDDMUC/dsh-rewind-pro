// The adapter is the only place the host's real contract is spelled out.
// Two things it must get exactly right, both learned the hard way:
//   * the surface fold emits the host's CURRENT SurfaceOp spelling
//     ({op:'replace', startSeq, endSeq}). The {start,end} shape this plugin was
//     originally written against is no longer accepted by Session.append.
//   * optional services are read through ctx.get(name, false), which needs no
//     inject declaration — cordis 4 THROWS on a plain property read instead.

import { describe, expect, it } from 'vitest'
import { detectAdapter, sessionToMessages } from '../../src/host/adapter'
import type { SurfaceOp } from '../../src/core/strategy-surface'

const sessionEvents = [
  { type: 'user/message', seq: 1, data: { content: 'write a parser' } },
  { type: 'assistant/message', seq: 2, data: { message: { content: 'sure' }, turn: 1, step: 1 } },
  { type: 'user/message', seq: 3, data: { content: 'now add tests' } },
  { type: 'assistant/message', seq: 4, data: { message: { content: 'ok' }, turn: 1, step: 1 } },
]

interface AppendRecord {
  type: unknown
  data: unknown
  opts: Record<string, unknown>
}

const makeSession = (appends: AppendRecord[]) => ({
  id: 'session-1',
  seq: 5,
  firstLiveSeq: 0,
  surface: { replaceGeneration: 0 },
  snapshotEvents: () => [...sessionEvents],
  append: (type: unknown, data: unknown, opts: Record<string, unknown>) => {
    appends.push({ type, data, opts })
    return { seq: 5 }
  },
})

describe('sessionToMessages', () => {
  it('maps user/assistant turns into the core message view', () => {
    const messages = sessionToMessages(makeSession([]))
    expect(messages.map((m) => [m.seq, m.role, m.text])).toEqual([
      [1, 'user', 'write a parser'],
      [2, 'assistant', 'sure'],
      [3, 'user', 'now add tests'],
      [4, 'assistant', 'ok'],
    ])
  })
})

describe('surface fold payload', () => {
  it('emits startSeq/endSeq and never the retired start/end spelling', async () => {
    const appends: AppendRecord[] = []
    const session = makeSession(appends)
    const probe = detectAdapter({ sessions: { list: () => [session], get: () => session } })

    const op: SurfaceOp = {
      type: 'replace',
      range: { start: 3, end: 4 },
      message: { role: 'system', text: 'hidden' },
    }
    await expect(probe.adapter.appendSurfaceOp(op)).resolves.toBe(true)

    expect(appends).toHaveLength(1)
    expect(appends[0].opts.surfaceOp).toEqual({ op: 'replace', startSeq: 3, endSeq: 4 })
    expect('start' in (appends[0].opts.surfaceOp as object)).toBe(false)
    expect(appends[0].opts.sourceEventSeqs).toEqual([3, 4])
  })

  it('appends a well-formed user message, not a bare content string', async () => {
    // `Session.append` does not validate the payload, so a malformed one is
    // accepted here and then reaches the model as `role: undefined` with a
    // string where text blocks belong.
    const appends: AppendRecord[] = []
    const session = makeSession(appends)
    const probe = detectAdapter({ sessions: { list: () => [session], get: () => session } })

    await probe.adapter.appendSurfaceOp({ type: 'replace', range: { start: 3, end: 4 }, message: { role: 'system', text: 'hidden' } })

    const data = appends[0].data as { role?: unknown; content?: unknown; source?: unknown }
    expect(data.role).toBe('user')
    expect(Array.isArray(data.content)).toBe(true)
    expect(data.content).toEqual([{ type: 'text', text: expect.stringContaining('2 earlier turns hidden') as unknown as string }])
    expect(data.source).toEqual({ kind: 'user' })
  })

  it('never rewrites node 0, which holds the system prompt', async () => {
    // The harness rejects a replace that covers node 0 wholesale, so a fold that
    // reached back that far would silently do nothing.
    const appends: AppendRecord[] = []
    const session = makeSession(appends)
    const probe = detectAdapter({ sessions: { list: () => [session], get: () => session } })

    await probe.adapter.appendSurfaceOp({ type: 'replace', range: { start: 0, end: 2 }, message: { role: 'system', text: 'hidden' } })

    expect(appends[0].opts.surfaceOp).toEqual({ op: 'replace', startSeq: 1, endSeq: 2 })
    expect(appends[0].opts.sourceEventSeqs).toEqual([1, 2])
  })
})

describe('branch shadow（分页重跑的第一步：真的遮蔽）', () => {
  it('按 dsh-rerun-turn 的形状落 5 条写入，替身是不可见的 system 消息', async () => {
    // 会话日志是追加式的：改不了历史，只能追加一个"替身"事件，让它的
    // surfaceOp.replace 把窗口内的节点从派生历史里删掉。
    // 替身刻意是 **空内容的 system 消息**：提示词随后由 prompt() 重新送进去，
    // 如果替身是可见的 user 消息，界面上就会出现两条提示词。
    const appends: AppendRecord[] = []
    const session = makeSession(appends)
    const probe = detectAdapter({ sessions: { list: () => [session], get: () => session } })

    const result = await probe.adapter.shadowWindow(undefined, {
      startSeq: 3,
      endSeq: 4,
      shadowed: [3, 4],
      turn: 2,
    })

    expect(result.ok).toBe(true)
    expect(appends.map((entry) => entry.type)).toEqual([
      'turn/start',
      'step/start',
      'system/message',
      'step/end',
      'turn/end',
    ])

    const carrier = appends[2]
    expect(carrier.opts.surfaceOp).toEqual({ op: 'replace', startSeq: 3, endSeq: 4 })
    expect(carrier.opts.sourceEventSeqs).toEqual([3, 4])
    const data = carrier.data as { turn?: unknown; step?: unknown; message?: { role?: unknown; content?: unknown } }
    expect(data.turn).toBe(2)
    expect(data.step).toBe(1)
    expect(data.message?.role).toBe('system')
    expect(data.message?.content).toEqual([])

    expect(appends[0].data).toEqual({ turn: 2 })
    expect(appends[4].data).toEqual({ turn: 2, reason: { kind: 'completed' } })
  })

  it('日志在写入前已经移动（seq 不符）就整体拒绝，绝不写半截', async () => {
    // 半截写入最坏的后果是留一个没有 turn/end 的悬空回合，让日志之后无法冷读。
    const appends: AppendRecord[] = []
    const session = { ...makeSession(appends), seq: 99 }
    const probe = detectAdapter({ sessions: { list: () => [session], get: () => session } })

    const result = await probe.adapter.shadowWindow(undefined, { startSeq: 3, endSeq: 4, shadowed: [3, 4], turn: 2 }, 5)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('stale')
    expect(appends).toHaveLength(0)
  })

  it('seq 相符时正常写入', async () => {
    const appends: AppendRecord[] = []
    const session = makeSession(appends)
    const probe = detectAdapter({ sessions: { list: () => [session], get: () => session } })

    const result = await probe.adapter.shadowWindow(undefined, { startSeq: 3, endSeq: 4, shadowed: [3, 4], turn: 2 }, 5)

    expect(result.ok).toBe(true)
    expect(appends).toHaveLength(5)
  })
})

describe('rerun prompt（分页重跑的第二步：真的重跑）', () => {
  it('用改写后的文本重新提示，带 sessionId / mode / 文本块', async () => {
    const calls: { request?: Record<string, unknown> }[] = []
    const sessionController = {
      prompt: (request: Record<string, unknown>) => {
        calls.push({ request })
        return Promise.resolve({ accepted: true })
      },
    }
    const probe = detectAdapter({
      sessions: { list: () => [makeSession([])], get: () => makeSession([]) },
      sessionController,
    })

    const result = await probe.adapter.promptSession('session-1', '甲改')

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    const request = calls[0]?.request
    expect(request?.sessionId).toBe('session-1')
    expect(request?.mode).toBe('queue')
    expect(request?.content).toEqual([{ type: 'text', text: '甲改' }])
    expect(typeof request?.requestId).toBe('string')
  })

  it('没有 sessionController 时如实失败，不假装成功', async () => {
    const probe = detectAdapter({ sessions: { list: () => [], get: () => undefined } })

    const result = await probe.adapter.promptSession('session-1', '甲改')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('sessionController')
  })
})

describe('planShadowFor（从日志里读窗口）', () => {
  const surfaceEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, surfaceOp: 'append', data: { content: '甲问' } },
    { type: 'assistant/message', seq: 3, surfaceOp: 'append', data: { message: { content: '答' } } },
    { type: 'turn/end', seq: 4, data: { turn: 1 } },
    { type: 'user/message', seq: 5, surfaceOp: 'append', data: { content: '乙问' } },
    { type: 'assistant/message', seq: 6, surfaceOp: 'append', data: { message: { content: '答乙' } } },
  ]
  const makeSurfaceSession = (events: unknown[]) => ({
    id: 'session-1',
    seq: events.length + 1,
    firstLiveSeq: 0,
    surface: { replaceGeneration: 0 },
    snapshotEvents: () => [...events],
    append: () => ({ seq: 1 }),
  })

  it('窗口 = 被点的消息 .. 最后一个 surface 节点，并带上当前日志长度做并发保护', () => {
    const session = makeSurfaceSession(surfaceEvents)
    const probe = detectAdapter({ sessions: { list: () => [session], get: () => session } })

    const result = probe.adapter.planShadowFor(5)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan).toEqual({ startSeq: 5, endSeq: 6, shadowed: [5, 6], turn: 2 })
    expect(result.expectedSeq).toBe(7)
  })

  it('目标不是 surface 节点时如实拒绝', () => {
    const session = makeSurfaceSession(surfaceEvents)
    const probe = detectAdapter({ sessions: { list: () => [session], get: () => session } })

    const result = probe.adapter.planShadowFor(4)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not a surface node')
  })

  it('整份日志都没有 surfaceOp 标记时，按事件类型兜底（否则功能会静默失效）', () => {
    // 真实日志两种形态都可能出现；如果只认 surfaceOp，这种日志上窗口会算成空，
    // 用户看到的就是"点了没反应"。
    const legacy = surfaceEvents.map(({ type, seq, data }) => ({ type, seq, data }))
    const session = makeSurfaceSession(legacy)
    const probe = detectAdapter({ sessions: { list: () => [session], get: () => session } })

    const result = probe.adapter.planShadowFor(5)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.shadowed).toEqual([5, 6])
  })
})

describe('capability reporting', () => {
  it('reports surface-op support even when no session is live', () => {
    // The bug this pins: probing through a live session answered `false` on a
    // host that accepts the append perfectly well — right after boot there is no
    // session — and that false reading removed surface-op from the strategy
    // ladder for the whole process.
    const ctx = { get: () => undefined, sessions: { list: () => [], get: () => undefined } }
    const probe = detectAdapter(ctx)
    expect(probe.bound).toBe(true)
    expect(probe.adapter.canAppendSurfaceOp()).toBe(true)
  })
})

describe('service reads', () => {
  it('reads the harness version through ctx.get without an inject declaration', () => {
    const ctx = {
      get: (name: string) => (name === 'dsh' ? { version: '0.2.0-rc.2' } : undefined),
      sessions: { list: () => [] },
    }
    expect(detectAdapter(ctx).adapter.dshVersion()).toBe('0.2.0-rc.2')
  })

  it('degrades to a null adapter when the sessions service is absent', () => {
    const probe = detectAdapter({})
    expect(probe.bound).toBe(false)
    expect(probe.notes.join(' ')).toContain('ctx.sessions unavailable')
    expect(probe.adapter.canAppendSurfaceOp()).toBe(false)
  })

  it('registers commands on the commands service and reports when there is none', () => {
    const registered: Array<{ name: string; description: string }> = []
    const ctx = {
      sessions: { list: () => [makeSession([])], get: () => makeSession([]) },
      get: (name: string) =>
        name === 'commands'
          ? {
              register: (definition: { name: string; description: string }) => {
                registered.push(definition)
                return () => undefined
              },
            }
          : undefined,
    }
    const probe = detectAdapter(ctx)
    probe.adapter.registerCommand({ name: 'rewind', description: 'list targets', handler: async () => 'ok' })
    expect(registered.map((d) => d.name)).toEqual(['rewind'])

    const bare = detectAdapter({ sessions: { list: () => [], get: () => undefined } })
    bare.adapter.registerCommand({ name: 'rewind', description: 'list targets', handler: async () => 'ok' })
    expect(bare.notes.join(' ')).toContain('no command registry')
  })
})

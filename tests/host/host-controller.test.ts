// Host controller: the two-phase rewind state machine.
//
// mark -> pending (tail masked, target text in the draft, old draft stashed)
// send -> commit (main path: pre-step; fallback: session event)
// ✕    -> cancel (mask removed, draft restored)
// plus graded undo and history jump.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createRewindController } from '../../src/host/hooks'
import { DEFAULT_CONFIG } from '../../src/core/types'
import { cleanupTmp, writeFile as putFile } from './helpers/tmp'
import { conversation, FakeHost } from './helpers/fake-host'

afterAll(cleanupTmp)

const dirs: string[] = []
const freshDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rewind-ctrl-'))
  dirs.push(dir)
  return dir
}

let host: FakeHost
let controller: ReturnType<typeof createRewindController>

beforeEach(async () => {
  host = new FakeHost({ messages: conversation() })
  controller = createRewindController({
    adapter: host,
    ledgerDir: await freshDir(),
    snapshotRoot: await freshDir(),
    workspaceRoot: await freshDir(),
    config: { ...DEFAULT_CONFIG },
    now: () => 1000,
  })
})

describe('applyBranch（分页重跑：先遮蔽，再重跑）', () => {
  it('顺序必须是先遮蔽再重跑 —— 反过来历史里会有两份提示词', async () => {
    const calls: string[] = []
    host.shadows.length = 0
    host.prompts.length = 0
    host.shadowWindow = async (sessionId, plan, expectedSeq) => {
      calls.push('shadow')
      host.shadows.push({ sessionId, plan, expectedSeq })
      return { ok: true }
    }
    host.promptSession = async (sessionId, text) => {
      calls.push('prompt')
      host.prompts.push({ sessionId, text })
      return { ok: true }
    }

    const result = await controller.applyBranch({ sessionId: 'session-1', targetSeq: 3, text: '改写后的提示词' })

    expect(result.ok).toBe(true)
    expect(calls).toEqual(['shadow', 'prompt'])
    expect(host.shadows[0]?.plan.shadowed.length).toBeGreaterThan(0)
    expect(host.prompts[0]).toEqual({ sessionId: 'session-1', text: '改写后的提示词' })
  })

  it('没有重跑能力时**连遮蔽都不做** —— 半完成状态会把那段历史白遮掉（真机踩过）', async () => {
    host.canPromptValue = false
    host.shadows.length = 0
    host.prompts.length = 0

    const result = await controller.applyBranch({ sessionId: 'session-1', targetSeq: 3, text: 'x' })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('sessionController')
    expect(host.shadows).toHaveLength(0)
    expect(host.prompts).toHaveLength(0)
  })

  it('目标不是 surface 节点时什么都不做（不写日志、不重跑）', async () => {
    host.planVerdict = { ok: false, reason: 'seq 9 is not a surface node' }
    host.shadows.length = 0
    host.prompts.length = 0

    const result = await controller.applyBranch({ sessionId: 'session-1', targetSeq: 9, text: 'x' })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('not a surface node')
    expect(host.shadows).toHaveLength(0)
    expect(host.prompts).toHaveLength(0)
  })

  it('遮蔽失败就绝不重跑（否则等于往没遮蔽的历史里再塞一条提示词）', async () => {
    host.shadowVerdict = { ok: false, reason: 'stale: expected seq 5, found 7' }
    host.shadows.length = 0
    host.prompts.length = 0

    const result = await controller.applyBranch({ sessionId: 'session-1', targetSeq: 3, text: 'x' })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('stale')
    expect(host.prompts).toHaveLength(0)
  })

  it('重跑被拒时如实报告（遮蔽已经落地，这一点必须说清）', async () => {
    host.promptVerdict = { ok: false, reason: 'sessionController.prompt unavailable' }
    host.shadows.length = 0
    host.prompts.length = 0

    const result = await controller.applyBranch({ sessionId: 'session-1', targetSeq: 3, text: 'x' })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('sessionController')
    expect(host.shadows).toHaveLength(1)
    expect(result.shadowed).toBe(true)
  })
})

describe('mark (phase one)', () => {
  it('stashes the draft and fills the target text without mutating the session', async () => {
    await host.setDraft('half-typed thought')
    const result = await controller.mark({ sessionId: 'session-1', targetSeq: 3 })

    expect(result.ok).toBe(true)
    // Fork strategy: the session itself is never touched while pending —
    // the fork at commit time is what makes undo trivially possible.
    expect(host.forks).toEqual([])
    expect(host.draft).toBe('now add tests')
    expect(controller.stashedDraft('session-1')).toBe('half-typed thought')
    expect(controller.state('session-1').pending?.targetSeq).toBe(3)
    // Interrupting the running turn is what makes the tail stop growing.
    expect(host.interrupts).toBe(1)
  })

  it('refuses a target that is not in the session', async () => {
    const result = await controller.mark({ sessionId: 'session-1', targetSeq: 99 })
    expect(result).toMatchObject({ ok: false })
    expect(host.deriveRanges).toEqual([])
  })
})

describe('cancel', () => {
  it('puts the stashed draft back without touching the session', async () => {
    await host.setDraft('half-typed thought')
    await controller.mark({ sessionId: 'session-1', targetSeq: 3 })

    const result = await controller.cancel({ sessionId: 'session-1' })

    expect(result.ok).toBe(true)
    expect(host.forks).toEqual([])
    expect(host.draft).toBe('half-typed thought')
    expect(controller.state('session-1').pending).toBeNull()
  })

  it('is a no-op when nothing is pending', async () => {
    expect((await controller.cancel({ sessionId: 'session-1' })).ok).toBe(false)
  })
})

describe('commit (phase two)', () => {
  it('commits on the pre-step path by forking at the boundary', async () => {
    await controller.mark({ sessionId: 'session-1', targetSeq: 3 })
    const result = await controller.handleBeforeStep({ sessionId: 'session-1', text: 'now add tests' })

    expect(result.committed).toBe(true)
    // targetSeq 3 => the child keeps seqs 1..2 (boundary is inclusive).
    expect(host.forks).toEqual([{ boundary: 2 }])
    expect(host.followed[0]).toBe('session-1-child-1')
    const state = controller.state('session-1')
    expect(state.pending).toBeNull()
    expect(state.ranges).toEqual([{ start: 3, end: 4 }])
  })

  it('falls back to a session event when pre-step never fires', async () => {
    await controller.mark({ sessionId: 'session-1', targetSeq: 3 })
    host.messages = [...host.messages, { seq: 5, role: 'user', text: 'now add tests' }]

    const result = await controller.handleSessionEvent({
      sessionId: 'session-1',
      type: 'message',
      payload: { seq: 5, role: 'user', text: 'now add tests' },
    })

    expect(result.committed).toBe(true)
    expect(controller.state('session-1').ranges).toEqual([{ start: 3, end: 5 }])
  })

  it('does not commit twice when both paths fire', async () => {
    await controller.mark({ sessionId: 'session-1', targetSeq: 3 })
    await controller.handleBeforeStep({ sessionId: 'session-1', text: 'now add tests' })
    host.messages = [...host.messages, { seq: 5, role: 'user', text: 'now add tests' }]
    await controller.handleSessionEvent({ sessionId: 'session-1', type: 'message', payload: { seq: 5 } })

    expect(controller.state('session-1').ranges).toEqual([{ start: 3, end: 4 }])
    expect(host.forks).toHaveLength(1)
  })

  it('refuses to commit when the session epoch moved on', async () => {
    await controller.mark({ sessionId: 'session-1', targetSeq: 3 })
    host.epochValue = 'epoch-2'

    const result = await controller.handleBeforeStep({ sessionId: 'session-1', text: 'now add tests' })
    expect(result).toMatchObject({ committed: false, reason: 'stale-epoch' })
  })
})

describe('undo', () => {
  const committed = async () => {
    await controller.mark({ sessionId: 'session-1', targetSeq: 3 })
    await controller.handleBeforeStep({ sessionId: 'session-1', text: 'now add tests' })
  }

  it('follows the client back to the parent on a clean undo', async () => {
    await committed()
    expect(host.followed).toEqual(['session-1-child-1'])

    const result = await controller.undo({ sessionId: 'session-1' })

    expect(result.grade).toBe('clean')
    // The parent log was never touched; undo is just following back.
    expect(host.followed).toEqual(['session-1-child-1', 'session-1'])
    expect(controller.state('session-1').ranges).toEqual([])
  })

  it('asks for confirmation when turns were written after the rewind', async () => {
    await committed()
    host.messages = [...host.messages, { seq: 5, role: 'user', text: 'and one more thing' }]

    const asked = await controller.undo({ sessionId: 'session-1' })
    expect(asked.grade).toBe('dirty')
    expect(asked.applied).toBe(false)
    expect(host.followed).toHaveLength(1)

    const forced = await controller.undo({ sessionId: 'session-1', force: true })
    expect(forced.applied).toBe(true)
    expect(host.followed).toEqual(['session-1-child-1', 'session-1'])
  })

  it('refuses an irreversible rewind and says why', async () => {
    const surfaceOnly = new FakeHost({ messages: conversation(), canPatch: false, canSurface: true })
    const ctrl = createRewindController({
      adapter: surfaceOnly,
      ledgerDir: await freshDir(),
      snapshotRoot: await freshDir(),
      workspaceRoot: await freshDir(),
      config: { ...DEFAULT_CONFIG },
      now: () => 1000,
    })
    await ctrl.mark({ sessionId: 'session-1', targetSeq: 3 })
    await ctrl.handleBeforeStep({ sessionId: 'session-1', text: 'now add tests' })

    const result = await ctrl.undo({ sessionId: 'session-1', force: true })
    expect(result.grade).toBe('irreversible')
    expect(result.applied).toBe(false)
    expect(result.reason).toBeTruthy()
  })
})

describe('history jump', () => {
  it('re-applies an earlier ledger state without losing the log', async () => {
    await controller.mark({ sessionId: 'session-1', targetSeq: 3 })
    await controller.handleBeforeStep({ sessionId: 'session-1', text: 'now add tests' })
    await controller.undo({ sessionId: 'session-1' })

    const result = await controller.jump({ sessionId: 'session-1', toIndex: 1 })
    expect(result.ok).toBe(true)
    expect(controller.state('session-1').ranges).toEqual([{ start: 3, end: 4 }])
    expect(controller.state('session-1').history.length).toBeGreaterThan(2)
  })
})

describe('write hook', () => {
  it('backs a file up before the write lands', async () => {
    const abs = await putFile(controller.workspaceRoot, 'src/parser.ts', 'v1')

    await controller.handleBeforeWrite({ sessionId: 'session-1', absPath: abs, turnSeq: 4 })
    const anchor = await controller.snapshotAnchor('session-1', 'turn-4')
    expect(anchor?.files.map((f) => f.path)).toEqual(['src/parser.ts'])
  })
})

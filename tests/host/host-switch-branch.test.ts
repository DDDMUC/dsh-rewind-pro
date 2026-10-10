// 把切分支接到宿主：`switchBranch` 的规格。
//
// 输入：客户端报上来的**活动路径上的用户消息 id**（客户端只认得这些）。
// 步骤：按日志展开成整回合 → 算当前 surface 节点 → 规划写入 → 追加。
//
// 三条纪律：
//   1. **拿不到 surface 就拒绝**：自己折叠出来的只能当参考，权威在宿主
//      （session.surface.nodes）。没有权威就不写。
//   2. **seq 不符就整体拒绝**：日志在写入前移动过，半截写入比不写更糟。
//   3. **一条写入失败就停**并回报失败原因，不假装成功。

import { describe, expect, it } from 'vitest'
import { createRewindController } from '../../src/host/hooks'
import { DEFAULT_CONFIG } from '../../src/core/types'
import { FakeHost, conversation } from './helpers/fake-host'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dirs: string[] = []
const freshDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rewind-switch-'))
  dirs.push(dir)
  return dir
}

const user = (seq: number, id: string, text: string) => ({ seq, type: 'user/message', surfaceOp: 'append', data: { id, role: 'user', content: [{ type: 'text', text }] } })
const assistant = (seq: number, id: string, text: string) => ({ seq, type: 'assistant/message', surfaceOp: 'append', data: { message: { id, role: 'assistant', content: [{ type: 'text', text }] } } })

const EVENTS = [
  { seq: 0, type: 'system/message', surfaceOp: 'append', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }] } } },
  user(1, 'u1', '甲问'),
  assistant(2, 'a1', '答甲'),
  user(3, 'u2', '乙问'),
  assistant(4, 'a2', '答乙'),
  user(5, 'u2b', '乙问改'),
  assistant(6, 'a2b', '答乙改'),
]

let host: FakeHost
let controller: ReturnType<typeof createRewindController>

const setup = async () => {
  host = new FakeHost({ messages: conversation() })
  host.events = EVENTS
  host.surfaceNodeList = [0, 1, 2, 3, 4, 5, 6]
  controller = createRewindController({
    adapter: host,
    ledgerDir: await freshDir(),
    snapshotRoot: await freshDir(),
    workspaceRoot: await freshDir(),
    config: { ...DEFAULT_CONFIG },
    now: () => 1000,
  })
}

describe('switchBranch（切分支）', () => {
  it('切回老分支：规划出遮蔽 + 需要的重放，并把写入交给宿主', async () => {
    await setup()
    const result = await controller.switchBranch({ sessionId: 'session-1', targetUserIds: ['u1', 'u2'] })

    expect(result.ok).toBe(true)
    // 目标是 surface 的前缀 → 只需要遮蔽，不重放
    expect(result.replayed).toBe(0)
    expect(result.shadowed).toBe(2)
    expect(host.appendedWrites).toHaveLength(5) // turn/start + step/start + 替身 + step/end + turn/end
    expect(host.appendedWrites[2]?.type).toBe('system/message')
  })

  it('往前切：老分支在 surface 前面 → 遮蔽 + 重放新分支', async () => {
    await setup()
    const result = await controller.switchBranch({ sessionId: 'session-1', targetUserIds: ['u1', 'u2b'] })

    expect(result.ok).toBe(true)
    expect(result.replayed).toBe(2) // u2b + a2b 在被遮蔽范围内，要重放回来
    const types = host.appendedWrites.map((write) => write.type)
    expect(types).toContain('user/message')
    expect(types).toContain('assistant/message')
  })

  it('没有 surface 节点（宿主没给）→ 拒绝写入，不让客户端干等', async () => {
    await setup()
    host.surfaceNodeList = null
    const result = await controller.switchBranch({ sessionId: 'session-1', targetUserIds: ['u1', 'u2'] })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('surface')
    expect(host.appendedWrites).toHaveLength(0)
  })

  it('空的用户 id → 明确拒绝（不猜）', async () => {
    await setup()
    const result = await controller.switchBranch({ sessionId: 'session-1', targetUserIds: [] })
    expect(result.ok).toBe(false)
  })

  it('日志在写入前移动过（seq 不符）→ 整体拒绝', async () => {
    await setup()
    host.appendSeqGuard = 5 // 期望 seq 与宿主当前不符
    const result = await controller.switchBranch({
      sessionId: 'session-1',
      targetUserIds: ['u1', 'u2'],
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('seq')
    expect(host.appendedWrites).toHaveLength(0)
  })
})

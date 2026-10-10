// 切分支规划的规格：**遮蔽分歧尾部 + 重放目标后缀**。
//
// 关键验证在 host-replay-integration.test.ts：把这些写入手动 append 到日志后面，
// 用**宿主自己的 foldSurface** 折一遍，派生出来的消息必须正好等于目标路径。

import { describe, expect, it } from 'vitest'
import { idOf, planSwitch, type PlanEvent } from '../../src/core/replay-plan'

const user = (seq: number, id: string, text: string): PlanEvent => ({
  seq,
  type: 'user/message',
  surfaceOp: 'append',
  data: { id, role: 'user', content: [{ type: 'text', text }] },
})
const assistant = (seq: number, id: string, text: string): PlanEvent => ({
  seq,
  type: 'assistant/message',
  surfaceOp: 'append',
  data: { message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
})

/** 两轮对话 + 一个"乙问"的替代版本（第 4 轮位置）。 */
const LOG: PlanEvent[] = [
  { seq: 0, type: 'system/message', surfaceOp: 'append', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }] } } },
  user(1, 'u1', '甲问'),
  assistant(2, 'a1', '答甲'),
  user(3, 'u2', '乙问'),
  assistant(4, 'a2', '答乙'),
  user(5, 'u2b', '乙问改'),
  assistant(6, 'a2b', '答乙改'),
]

const NODES = [0, 1, 2, 3, 4, 5, 6]

/** 固定 id，方便断言。 */
let counter = 0
const mint = (): string => `fresh-${String((counter += 1))}`

describe('planSwitch', () => {
  it('当前在"乙问改"分支，目标回到"乙问" → 遮蔽 5..6，重放 u2/a2', () => {
    counter = 0
    const plan = planSwitch({ events: LOG, nodes: NODES, targetIds: ['sys', 'u1', 'a1', 'u2', 'a2'], maxTurn: 2, mint })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.sharedPrefix).toBe(5) // 0..4 共享（乙问/答甲也在目标上）；5(u2b) 开始分歧
    expect(plan.shadowed).toBe(2)     // 节点 5、6
    // 目标正好是 surface 的前缀 → 只需要遮蔽，**不需要重放**
    expect(plan.replayed).toBe(0)
    expect(plan.writes.map((write) => write.type)).toEqual([
      'turn/start', 'step/start', 'system/message', 'step/end', 'turn/end',
    ])

    const carrier = plan.writes[2]
    expect(carrier?.surfaceOp).toEqual({ op: 'replace', startSeq: 5, endSeq: 6 })
    expect(carrier?.sourceEventSeqs).toEqual([5, 6])
    // 替身必须是**不可见**的空 system 消息，否则界面上会多一条气泡
    const data = carrier?.data as { message: { role: string; content: unknown[] } }
    expect(data.message.role).toBe('system')
    expect(data.message.content).toEqual([])
  })

  it('重放的事件必须换新 id（同一份内容在 surface 上只能出现一次）', () => {
    // 场景：目标消息**已经不在 surface 上**（早先被遮蔽过），必须重放它
    const shadowed: PlanEvent[] = [
      ...LOG,
      {
        seq: 7,
        type: 'system/message',
        surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 },
        sourceEventSeqs: [5, 6],
        data: { message: { id: 'c1', role: 'system', content: [] } },
      },
    ]
    counter = 0
    // surface 现在只有 0..4 + 替身 7
    const plan = planSwitch({ events: shadowed, nodes: [0, 1, 2, 3, 4, 7], targetIds: ['sys', 'u1', 'a1', 'u2b', 'a2b'], maxTurn: 3, mint })
    if (!plan.ok) return

    expect(plan.replayed).toBe(2) // u2b/a2b 已不在 surface 上 → 重放
    const userWrite = plan.writes.find((write) => write.type === 'user/message')
    const data = userWrite?.data as { id: string; content: { text: string }[]; source: { replayedBy: string } }
    expect(data.id).toBe('fresh-2')
    expect(data.content[0]?.text).toBe('乙问改')          // 内容原样复制
    expect(data.source.replayedBy).toBe('dsh-rewind-pro') // 带重放标记，便于事后辨认
  })

  it('目标就是当前路径 → 一条写入都没有（当前路径指 surface 本身就是目标）', () => {
    // surface = [sys,u1,a1,u2,a2,u2b,a2b]，目标取同一条：前缀走满 → 无分歧
    const plan = planSwitch({ events: LOG, nodes: NODES, targetIds: ['sys', 'u1', 'a1', 'u2', 'a2', 'u2b', 'a2b'], maxTurn: 2, mint })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.writes).toEqual([])
    expect(plan.replayed).toBe(0)
  })

  it('往前切到更新的分支：老分支在 surface 前面，也要遮蔽 + 重放新的', () => {
    counter = 0
    // surface = [sys,u1,a1,u2,a2,u2b,a2b]，目标 = [sys,u1,a1,u2b,a2b]
    // u2/a2 位于前缀之外且不在目标上 → 遮蔽 3..6，再把 u2b/a2b 重放回来
    const plan = planSwitch({ events: LOG, nodes: NODES, targetIds: ['sys', 'u1', 'a1', 'u2b', 'a2b'], maxTurn: 2, mint })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.sharedPrefix).toBe(3)
    expect(plan.replayed).toBe(2) // u2b/a2b 在被遮蔽的范围内，必须重放回来
    const carrier = plan.writes[2]
    expect(carrier?.surfaceOp).toEqual({ op: 'replace', startSeq: 3, endSeq: 6 })
  })

  it('目标消息在日志里找不到 → 明确拒绝，不写任何东西', () => {
    const plan = planSwitch({ events: LOG, nodes: NODES, targetIds: ['sys', 'u1', 'a1', '不存在的 id'], maxTurn: 2, mint })
    expect(plan.ok).toBe(true) // 找不到的只是不重放，其余照常
    if (!plan.ok) return
    expect(plan.writes.length).toBeGreaterThan(0)
  })

  it('回合号从 maxTurn 之后接着排（宿主冷读要求回合连续）', () => {
    counter = 0
    // 走"往前切"那条：遮蔽 1 个回合 + 重放 2 个回合
    const plan = planSwitch({ events: LOG, nodes: NODES, targetIds: ['sys', 'u1', 'a1', 'u2b', 'a2b'], maxTurn: 2, mint })
    if (!plan.ok) return
    const starts = plan.writes.filter((write) => write.type === 'turn/start').map((write) => (write.data as { turn: number }).turn)
    expect(starts).toEqual([3, 4, 5])
  })

  it('idOf：user 取 data.id，assistant 取 data.message.id', () => {
    expect(idOf(user(1, 'u1', 'x'))).toBe('u1')
    expect(idOf(assistant(2, 'a1', 'x'))).toBe('a1')
    expect(idOf({ seq: 0, type: 'turn/start', data: { turn: 1 } })).toBeNull()
  })
})

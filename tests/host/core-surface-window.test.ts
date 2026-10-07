// Surface 窗口规划的规格：照 dsh-rerun-turn / dsh-edit-turn 的 foldSurface 语义实现，
// 这里的每条用例都对应一个真实场景（追加、被覆盖、目标已被遮蔽、合成回合号）。

import { describe, expect, it } from 'vitest'
import { foldSurface, planShadow, type SurfaceEventLike } from '../../src/core/surface-window'

const user = (seq: number, text: string): SurfaceEventLike => ({
  seq,
  type: 'user/message',
  surfaceOp: 'append',
  data: { content: text },
})
const assistant = (seq: number): SurfaceEventLike => ({ seq, type: 'assistant/message', surfaceOp: 'append', data: {} })
const chunk = (seq: number): SurfaceEventLike => ({ seq, type: 'assistant/chunk', data: {} })
const turnStart = (seq: number, turn: number): SurfaceEventLike => ({ seq, type: 'turn/start', data: { turn } })
const turnEnd = (seq: number, turn: number): SurfaceEventLike => ({ seq, type: 'turn/end', data: { turn } })

describe('foldSurface', () => {
  it('只收 surface 事件，chunk 与回合边界不算节点', () => {
    const events = [turnStart(1, 1), user(2, '甲'), chunk(3), assistant(4), turnEnd(5, 1)]
    expect(foldSurface(events).nodes).toEqual([2, 4])
    expect(foldSurface(events).maxTurn).toBe(1)
  })

  it('replace 会把窗口内的节点删掉，并把替身自己算作节点', () => {
    const events: SurfaceEventLike[] = [
      user(2, '甲'),
      assistant(3),
      user(4, '乙'),
      // 用 seq 9 的替身遮蔽 4..4（把"乙"换掉）
      { seq: 9, type: 'system/message', surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, data: {} },
    ]
    expect(foldSurface(events).nodes).toEqual([2, 3, 9])
  })

  it('多次 replace 连起来也能正确折叠（后一次盖前一次）', () => {
    const events: SurfaceEventLike[] = [
      user(2, '甲'),
      user(3, '乙'),
      { seq: 4, type: 'system/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: {} },
      { seq: 5, type: 'system/message', surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, data: {} },
    ]
    expect(foldSurface(events).nodes).toEqual([2, 5])
  })
})

describe('planShadow', () => {
  const events: SurfaceEventLike[] = [
    turnStart(1, 1),
    user(2, '甲问'),
    assistant(3),
    turnEnd(4, 1),
    turnStart(5, 2),
    user(6, '乙问'),
    assistant(7),
    turnEnd(8, 2),
  ]

  it('窗口 = 被点的消息 .. 最后一个 surface 节点，且带齐全部被遮蔽节点', () => {
    const result = planShadow(events, 6)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan).toEqual({ startSeq: 6, endSeq: 7, shadowed: [6, 7], turn: 3 })
  })

  it('从第一轮起遮蔽时包含后面所有节点', () => {
    const result = planShadow(events, 2)
    expect(result.ok && result.plan.shadowed).toEqual([2, 3, 6, 7])
  })

  it('目标不是 surface 节点时明确拒绝（可能已被更早的 replace 遮蔽）', () => {
    const withReplace: SurfaceEventLike[] = [
      ...events,
      { seq: 9, type: 'system/message', surfaceOp: { op: 'replace', startSeq: 6, endSeq: 7 }, data: {} },
    ]
    const result = planShadow(withReplace, 6)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not a surface node')
  })

  it('空 surface 时拒绝', () => {
    const result = planShadow([turnStart(1, 1)], 1)
    expect(result.ok).toBe(false)
  })
})

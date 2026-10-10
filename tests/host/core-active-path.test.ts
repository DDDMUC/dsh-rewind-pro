// 「被顶掉的版本」投影的规格。
//
// 三条必须钉死的纪律（都来自宿主源码与实测）：
//   1. **默认恒等**：投影全宿主范围，没被标记的消息一个都不能动。
//   2. **按消息 id 点名**：宿主持给投影的 ctx 里没有 sessionId，而 seq 每会话
//      各自编号会撞号；实测用户消息带稳定的 `data.id`。
//   3. **拿不到 id 就放行**：宁可放过，不可按猜的标识乱删。

import { describe, expect, it } from 'vitest'
import { SupersededRegistry, createUserMessageProjection } from '../../src/core/active-path'

const userEvent = (seq: number, id: string | null, text = '甲问') => ({
  seq,
  type: 'user/message' as const,
  ...(id === null ? {} : { data: { id, role: 'user', content: [{ type: 'text', text }] } }),
})

const CTX = { nodes: [], events: [], baseSeq: 0, messages: new Map() }

describe('createUserMessageProjection', () => {
  it('默认恒等：什么都没标记时，一条都不该动', () => {
    const projection = createUserMessageProjection(new SupersededRegistry())
    expect([...projection.project(userEvent(12, 'id-a'), CTX).keys()]).toEqual([])
  })

  it('被标记的 id → 返回 [[seq, null]]（从派生历史里删除）', () => {
    const registry = new SupersededRegistry()
    registry.add('id-old')
    const projection = createUserMessageProjection(registry)

    expect([...projection.project(userEvent(20, 'id-old'), CTX).entries()]).toEqual([[20, null]])
  })

  it('同一 seq、不同 id：只删被标记的那个（证明按 id 而不是按 seq）', () => {
    const registry = new SupersededRegistry()
    registry.add('id-old')
    const projection = createUserMessageProjection(registry)

    expect([...projection.project(userEvent(9, 'id-keep'), CTX).keys()]).toEqual([])
    expect([...projection.project(userEvent(9, 'id-old'), CTX).entries()]).toEqual([[9, null]])
  })

  it('翻回某个版本：把它从清单移除后立刻恢复', () => {
    const registry = new SupersededRegistry()
    registry.add('id-old')
    const projection = createUserMessageProjection(registry)
    expect([...projection.project(userEvent(20, 'id-old'), CTX).entries()]).toEqual([[20, null]])

    registry.remove('id-old')
    expect([...projection.project(userEvent(20, 'id-old'), CTX).keys()]).toEqual([])
  })

  it('事件没有 id 时一律放行（宁可放过，不可乱删）', () => {
    const registry = new SupersededRegistry()
    registry.add('id-old')
    const projection = createUserMessageProjection(registry)
    expect([...projection.project(userEvent(30, null), CTX).keys()]).toEqual([])
  })

  it('不是用户消息的 type 一律不碰', () => {
    const registry = new SupersededRegistry()
    registry.add('id-old')
    const projection = createUserMessageProjection(registry)
    expect([...projection.project({ seq: 40, type: 'assistant/message', data: { id: 'id-old' } }, CTX).keys()]).toEqual([])
  })

  it('投影必须是纯函数：不改动传进来的事件', () => {
    const registry = new SupersededRegistry()
    registry.add('id-old')
    const projection = createUserMessageProjection(registry)
    const event = userEvent(20, 'id-old')

    projection.project(event, CTX)

    expect((event.data as { content: unknown }).content).toEqual([{ type: 'text', text: '甲问' }])
  })
})

describe('SupersededRegistry', () => {
  it('只认被明确标记的 id', () => {
    const registry = new SupersededRegistry()
    expect(registry.has('x')).toBe(false)
    registry.add('x')
    expect(registry.has('x')).toBe(true)
    registry.remove('x')
    expect(registry.has('x')).toBe(false)
  })

  it('重复标记同一个 id 不会重复计算', () => {
    const registry = new SupersededRegistry()
    registry.add('x')
    registry.add('x')
    expect(registry.size()).toBe(1)
  })
})

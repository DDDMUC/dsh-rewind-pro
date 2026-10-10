// 「被顶掉的版本」投影的规格（第二步：按会话登记 + 覆盖语义）。
//
// 纪律（宿主源码级依据）：
//   1. **默认恒等**：投影全宿主范围，没被登记的消息一个都不能动。
//   2. **按消息 id 点名**：宿主持给投影的 ctx 里没有 sessionId，seq 又每会话各自
//      编号会撞号；实测消息带稳定 `data.id`（`assistant/tool` 在 `data.message.id`）。
//   3. **拿不到 id 就放行**：宁可放过，不可按猜的标识乱删。
//   4. **覆盖语义**：客户端每次上报"这个会话完整的顶掉清单"，服务端整体替换 ——
//      幂等，断线重传也不会把旧状态留下。

import { describe, expect, it } from 'vitest'
import { SupersededRegistry, createMessageProjections, expandToTurns, messageIdOf } from '../../src/core/active-path'

const userEvent = (seq: number, id: string | null) => ({
  seq,
  type: 'user/message',
  ...(id === null ? {} : { data: { id, role: 'user', content: [{ type: 'text', text: 'x' }] } }),
})
const assistantEvent = (seq: number, id: string | null) => ({
  seq,
  type: 'assistant/message',
  ...(id === null ? {} : { data: { message: { id, role: 'assistant', content: [{ type: 'text', text: 'x' }] } } }),
})
const toolEvent = (seq: number, id: string | null) => ({
  seq,
  type: 'tool/result',
  ...(id === null ? {} : { data: { message: { id, role: 'tool', content: [{ type: 'text', text: 'x' }] } } }),
})

const CTX = { nodes: [], events: [], baseSeq: 0, messages: new Map() }

describe('messageIdOf（三种消息事件都取得到稳定 id）', () => {
  it('user/message：id 在 data.id', () => {
    expect(messageIdOf(userEvent(9, 'a-user'))).toBe('a-user')
  })

  it('assistant/message / tool/result：id 在 data.message.id', () => {
    expect(messageIdOf(assistantEvent(10, 'a-assistant'))).toBe('a-assistant')
    expect(messageIdOf(toolEvent(11, 'a-tool'))).toBe('a-tool')
  })

  it('取不到 id 一律返回 null（上层据此放行）', () => {
    expect(messageIdOf(userEvent(9, null))).toBeNull()
    expect(messageIdOf({ seq: 9, type: 'turn/start', data: { turn: 1 } })).toBeNull()
    expect(messageIdOf({ seq: 9, type: 'user/message' })).toBeNull()
  })
})

describe('SupersededRegistry（按会话 + 覆盖语义）', () => {
  it('覆盖语义：同一会话再次上报整体替换，不是追加', () => {
    const registry = new SupersededRegistry()
    registry.set('s1', ['a', 'b'])
    registry.set('s1', ['c'])
    expect(registry.get('s1')).toEqual(['c'])
    expect(registry.has('a')).toBe(false)
    expect(registry.has('c')).toBe(true)
  })

  it('has() 是全会话范围的：按 id 点名，与在哪个会话无关', () => {
    const registry = new SupersededRegistry()
    registry.set('s1', ['a'])
    expect(registry.has('a')).toBe(true)
  })

  it('没登记的会话 → get 返回 null、has 任何 id 都 false', () => {
    const registry = new SupersededRegistry()
    expect(registry.get('nope')).toBeNull()
    expect(registry.has('whatever')).toBe(false)
  })

  it('clear 一个会话只清它自己', () => {
    const registry = new SupersededRegistry()
    registry.set('s1', ['a'])
    registry.set('s2', ['b'])
    registry.clear('s1')
    expect(registry.get('s1')).toBeNull()
    expect(registry.get('s2')).toEqual(['b'])
  })

  it('过滤空串与脏值（宁缺毋滥）', () => {
    const registry = new SupersededRegistry()
    registry.set('s1', ['a', '', 'a', 'b'])
    expect(registry.get('s1')).toEqual(['a', 'b'])
  })
})

describe('expandToTurns（一个用户消息 → 它那一整个回合的消息 id）', () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'u1' } },
    { seq: 3, type: 'assistant/message', data: { message: { id: 'a1' } } },
    { seq: 4, type: 'tool/result', data: { message: { id: 't1' } } },
    { seq: 5, type: 'turn/end', data: { turn: 1 } },
    { seq: 6, type: 'user/message', data: { id: 'u2' } },
    { seq: 7, type: 'assistant/message', data: { message: { id: 'a2' } } },
  ]

  it('命中一条用户消息 → 把它到下一个用户消息之前的消息全收进来', () => {
    expect(expandToTurns(events, ['u1'])).toEqual(['u1', 'a1', 't1'])
  })

  it('最后一条用户消息 → 收到日志末尾', () => {
    expect(expandToTurns(events, ['u2'])).toEqual(['u2', 'a2'])
  })

  it('多个 id 各自展开并去重', () => {
    expect(expandToTurns(events, ['u1', 'u2'])).toEqual(['u1', 'a1', 't1', 'u2', 'a2'])
  })

  it('turn/step 边界不是消息，不该被收进来', () => {
    expect(expandToTurns(events, ['u1'])).not.toContain('1')
  })

  it('没命中的 id → 空数组', () => {
    expect(expandToTurns(events, ['nope'])).toEqual([])
  })

  it('没有 id 的消息不会因为挨得近就被误删（只认点名的那条）', () => {
    const messy = [
      { seq: 1, type: 'user/message', data: { id: 'u1' } },
      { seq: 2, type: 'user/message' }, // 没有 id
      { seq: 3, type: 'assistant/message', data: { message: { id: 'a2' } } },
    ]
    // 只展开 u1：第二个用户消息（无 id）不该被连坐
    expect(expandToTurns(messy, ['u1'])).toEqual(['u1'])
  })
})

describe('createMessageProjections（同时管三种消息事件）', () => {
  it('三类事件各有一个投影，且都不在默认状态下动任何东西', () => {
    const projections = createMessageProjections(new SupersededRegistry())
    expect(projections.map((item) => item.type).sort()).toEqual(['assistant/message', 'tool/result', 'user/message'])
    for (const projection of projections) {
      const event = projection.type === 'user/message' ? userEvent(9, 'x') : assistantEvent(9, 'x')
      expect([...projection.project(event, CTX).keys()]).toEqual([])
    }
  })

  it('被点名的 id 在三种事件上都要被删（一条版本可能要跨多种事件）', () => {
    const registry = new SupersededRegistry()
    registry.set('s1', ['dead'])
    const projections = createMessageProjections(registry)

    expect([...projections[0].project(userEvent(9, 'dead'), CTX).entries()]).toEqual([[9, null]])
    expect([...projections[1].project(assistantEvent(10, 'dead'), CTX).entries()]).toEqual([[10, null]])
    expect([...projections[2].project(toolEvent(11, 'dead'), CTX).entries()]).toEqual([[11, null]])
  })

  it('只有 id 命中才删；同 seq 不同 id 不动', () => {
    const registry = new SupersededRegistry()
    registry.set('s1', ['dead'])
    const projections = createMessageProjections(registry)
    expect([...projections[0].project(userEvent(9, 'keep'), CTX).keys()]).toEqual([])
  })

  it('非消息事件（turn/step 边界）一律不碰', () => {
    const registry = new SupersededRegistry()
    registry.set('s1', ['dead'])
    const projections = createMessageProjections(registry)
    expect([...projections[0].project({ seq: 1, type: 'turn/start', data: { turn: 1 } }, CTX).keys()]).toEqual([])
  })
})

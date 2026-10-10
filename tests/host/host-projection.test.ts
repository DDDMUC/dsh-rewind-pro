// 投影注册的规格：三类消息事件都要装上才算"能隐藏"。
//
// 为什么必须三类齐全才启用：只删用户消息会把它的助手回复/工具结果**变成孤儿**
// （一条没有提问的回复），比不删更糟。所以任何一类没装上 → 整体不启用。

import { describe, expect, it } from 'vitest'
import { SupersededRegistry } from '../../src/core/active-path'
import { installMessageProjections, type ProjectionVerdict } from '../../src/host/projection'

/** 假宿主：方法**读 this**（和真宿主一样：内部用 this.projections 判重）。 */
function fakeSessions(taken: readonly string[] = []) {
  class FakeStore {
    projections: { type: string }[] = []
    registerMessageProjection(projection: { type: string }): () => Promise<void> {
      // 故意用 this：裸调（this 丢失）必须在这条用例里现形
      if (this.projections.some((item) => item.type === projection.type)) {
        throw new Error(`session message projection "${projection.type}" is already registered`)
      }
      this.projections.push(projection)
      return () => Promise.resolve()
    }
  }
  const store = new FakeStore()
  // 预先占用：模拟"别的插件已经注册了这些类型"
  for (const type of taken) store.projections.push({ type })
  return { sessions: store, registered: store.projections }
}

describe('installMessageProjections', () => {
  it('三类全部注册成功 → ready=true（且方法必须绑定 this 调用）', () => {
    const { sessions, registered } = fakeSessions()
    const verdict = installMessageProjections(sessions, new SupersededRegistry())
    expect(verdict.ready).toBe(true)
    expect(registered.map((item) => item.type).sort()).toEqual(['assistant/message', 'tool/result', 'user/message'])
    expect(verdict.skipped).toEqual([])
  })

  it('裸调方法会丢 this —— 宿主持内部读 this.projections，丢 this 就必须报出来', () => {
    // 真机上踩过：把方法取出来再调用，this 变成 undefined，宿主内部
    // "Cannot read properties of undefined (reading 'projections')" 然后被
    // 我的 try/catch 吞成"跳过"。这条用例保证它永远不会再发生。
    const { sessions } = fakeSessions()
    const method = sessions.registerMessageProjection
    expect(() => (method as (p: unknown) => unknown).call(undefined, { type: 'user/message' })).toThrow()
  })

  it('有一类被别的插件占用 → 那一类跳过，且**整体不启用**', () => {
    // 关键安全属性：半残状态比不做更危险（孤儿回复）。
    const { sessions, registered } = fakeSessions(['assistant/message'])
    const verdict = installMessageProjections(sessions, new SupersededRegistry())
    expect(verdict.ready).toBe(false)
    expect(verdict.installed.sort()).toEqual(['tool/result', 'user/message'])
    // 被占用那个必须报出宿主原话，否则没人知道为什么没装上
    expect(verdict.skipped).toHaveLength(1)
    expect(verdict.skipped[0]?.type).toBe('assistant/message')
    expect(verdict.skipped[0]?.reason).toContain('already registered')
  })

  it('宿主没有这个 API（老版本）→ 全部跳过，不启用，也不崩', () => {
    const verdict = installMessageProjections({}, new SupersededRegistry())
    expect(verdict.ready).toBe(false)
    expect(verdict.installed).toEqual([])
  })

  it('注册用的投影是恒等的：清单为空时点名不了任何东西', () => {
    const registry = new SupersededRegistry()
    const captured: { type: string; project: (e: unknown) => Map<number, unknown> }[] = []
    const sessions = {
      registerMessageProjection: (projection: { type: string; project: (e: unknown) => Map<number, unknown> }) => {
        captured.push(projection)
        return () => Promise.resolve()
      },
    }

    installMessageProjections(sessions, registry)

    for (const projection of captured) {
      const result = projection.project({ seq: 5, type: projection.type, data: { id: 'x' } })
      expect([...result.keys()]).toEqual([])
    }
  })

  it('verdict 里带 reason，便于 /health 直接给人看', () => {
    const verdict: ProjectionVerdict = installMessageProjections({}, new SupersededRegistry())
    expect(verdict.skipped.length).toBeGreaterThan(0)
    expect(typeof verdict.skipped[0]?.reason).toBe('string')
  })
})

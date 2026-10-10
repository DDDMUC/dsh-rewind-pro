// 投影注册的规格：三类消息事件都要装上才算"能隐藏"。
//
// 为什么必须三类齐全才启用：只删用户消息会把它的助手回复/工具结果**变成孤儿**
// （一条没有提问的回复），比不删更糟。所以任何一类没装上 → 整体不启用。

import { describe, expect, it } from 'vitest'
import { SupersededRegistry } from '../../src/core/active-path'
import { installMessageProjections, type ProjectionVerdict } from '../../src/host/projection'

/** 假宿主：可以指定哪些类型被别的插件占用了（注册即抛错）。 */
function fakeSessions(taken: readonly string[] = []) {
  const registered: string[] = []
  const sessions = {
    registerMessageProjection: (projection: { type: string }) => {
      if (taken.includes(projection.type)) {
        throw new Error(`session message projection "${projection.type}" is already registered`)
      }
      registered.push(projection.type)
      return () => Promise.resolve()
    },
  }
  return { sessions, registered }
}

describe('installMessageProjections', () => {
  it('三类全部注册成功 → ready=true', () => {
    const { sessions, registered } = fakeSessions()
    const verdict = installMessageProjections(sessions, new SupersededRegistry())
    expect(verdict.ready).toBe(true)
    expect(registered.sort()).toEqual(['assistant/message', 'tool/result', 'user/message'])
    expect(verdict.skipped).toEqual([])
  })

  it('有一类被别的插件占用 → 那一类跳过，且**整体不启用**', () => {
    // 关键安全属性：半残状态比不做更危险（孤儿回复）。
    const { sessions, registered } = fakeSessions(['assistant/message'])
    const verdict = installMessageProjections(sessions, new SupersededRegistry())
    expect(verdict.ready).toBe(false)
    expect(registered.sort()).toEqual(['tool/result', 'user/message'])
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

// 「重跑」必须由**客户端**发提示词。
//
// 真机日志实证：宿主插件调 `sessionController.prompt()` 返回 accepted，但日志里
// 一条事件都不写（queue / steer 都一样）；而**界面自己发的**消息都正常落地。
// 所以走界面同一条路：客户端 `sessions.using(...)` → `binding.session.prompt(...)`。

import { describe, expect, it } from 'vitest'
import { promptViaClientSessions } from '../../src/client/client-prompt'

/** 造一个形状与真实客户端 sessions 服务一致的替身。 */
function fakeSessions(options: { prompt?: (content: unknown, mode: unknown) => unknown; failReady?: boolean } = {}) {
  const calls: { content: unknown; mode: unknown }[] = []
  const sessions = {
    using: async (_target: unknown, opts: { source: string }, cb: (reference: unknown) => Promise<unknown>) => {
      const reference = {
        ready: options.failReady === true ? Promise.reject(new Error('open failed')) : Promise.resolve({}),
        binding: {
          session: {
            prompt: (content: unknown, mode: unknown) => {
              calls.push({ content, mode })
              return options.prompt ? options.prompt(content, mode) : Promise.resolve({ accepted: true })
            },
          },
        },
      }
      return await cb(reference)
    },
  }
  return { sessions, calls }
}

describe('promptViaClientSessions', () => {
  it('用界面同一条路发提示词：文本块 + queue', async () => {
    const { sessions, calls } = fakeSessions()

    const result = await promptViaClientSessions(sessions, 'session-1', '甲问改')

    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ content: [{ type: 'text', text: '甲问改' }], mode: 'queue' }])
  })

  it('没有客户端会话服务时如实失败（不假装成功）', async () => {
    const result = await promptViaClientSessions(undefined, 'session-1', '甲问改')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('sessions')
  })

  it('会话没有 prompt 能力时如实失败', async () => {
    const sessions = { using: async (_t: unknown, _o: unknown, cb: (r: unknown) => Promise<unknown>) => await cb({ ready: Promise.resolve({}), binding: { session: {} } }) }
    const result = await promptViaClientSessions(sessions, 'session-1', '甲问改')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('prompt')
  })

  it('prompt 抛错时把原始错误带出来', async () => {
    const { sessions } = fakeSessions({
      prompt: () => {
        throw new Error('session is not active')
      },
    })
    const result = await promptViaClientSessions(sessions, 'session-1', '甲问改')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('session is not active')
  })

  it('会话打不开（ready 失败）时如实失败', async () => {
    const { sessions } = fakeSessions({ failReady: true })
    const result = await promptViaClientSessions(sessions, 'session-1', '甲问改')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('open failed')
  })
})

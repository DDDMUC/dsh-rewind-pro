// 「重跑」由**客户端**发提示词（走界面同一条路）。
//
// 为什么不在宿主里发：真机日志实证 —— 宿主插件调 `sessionController.prompt()`
// 返回 `{accepted:true}`，但日志里**一条事件都不写**（queue / steer 都一样）；
// 而**界面自己发的**消息都正常落地（日志里 seq 8303/8314 就是）。
//
// 客户端接口（来自 @deepseek-ai/dsh-api-session-controller 的 /client 类型）：
//   ctx.sessions: ISessions
//   ISessions.using(target, { source }, cb)  → cb 拿到 SessionReference
//   SessionReference.ready → 首次打开落定；.binding.session: SessionFace
//   SessionFace.prompt(content, mode, signal?, requestId?)
// `source` 取自 SessionReferenceSourceMap（当前只有 controllerOperation / gateway）。

/** 与真实客户端服务保持一致的最小结构。 */
interface PromptCapableSession {
  prompt: (content: unknown, mode: string) => unknown
}

interface SessionReferenceLike {
  ready?: Promise<unknown>
  binding?: { session?: PromptCapableSession }
}

interface SessionsLike {
  using?: (
    target: string,
    options: { source: string },
    operation: (reference: SessionReferenceLike) => Promise<unknown>,
  ) => Promise<unknown>
}

/**
 * 用客户端会话服务发一条提示词。
 *
 * `ready` 要等：`SessionReference.binding` 在共享的首次 `open()` 落定之前不可用，
 * 直接读会失败。失败一律**如实回报**（带上原始错误），绝不假装成功。
 */
export async function promptViaClientSessions(
  sessions: unknown,
  sessionId: string,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  const service = sessions as SessionsLike | undefined
  if (!service || typeof service.using !== 'function') {
    return { ok: false, reason: '客户端没有可用的 sessions 服务（sessions.using）' }
  }

  try {
    const outcome = await service.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
      await reference.ready
      const session = reference.binding?.session
      if (!session || typeof session.prompt !== 'function') {
        return { ok: false, reason: '客户端会话没有 prompt 能力' }
      }
      await session.prompt([{ type: 'text', text }], 'queue')
      return { ok: true }
    })
    if (outcome && typeof outcome === 'object' && 'ok' in outcome) {
      return outcome as { ok: boolean; reason?: string }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `客户端发提示词失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

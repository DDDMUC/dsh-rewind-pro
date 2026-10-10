// 把「活动路径」投影注册到宿主。
//
// 安全属性（按重要性排）：
//   1. **三类齐全才启用**：只删用户消息会留下孤立的助手回复/工具结果，比不删更糟。
//      任何一类注册失败（被别的插件占用、宿主没这个 API）→ 整体 ready=false。
//   2. **默认恒等**：投影只对清单里点名的 id 动手；清单由客户端上报，服务端只做
//      登记与**按日志展开**（一个 user/message → 它那一整个回合的消息）。
//   3. **常驻不注销**：宿主持注明"disposing makes sessions that used it refuse
//      further derivation"，所以这里只注册、绝不调用 disposer。
//   4. **注册失败绝不影响插件其余部分**：每一次注册都单独 try，错误进 verdict。

import { createMessageProjections, PROJECTED_TYPES, SupersededRegistry } from '../core/active-path.js'

/** 一次注册的结果：装上了什么、跳过了什么、能不能开始隐藏。 */
export interface ProjectionVerdict {
  /** 成功注册的类型。 */
  installed: string[]
  /** 没能注册的类型与原因（给 /health 与日志看）。 */
  skipped: { type: string; reason: string }[]
  /** 三类齐全 = 可以开始隐藏；否则一律不隐藏。 */
  ready: boolean
}

/** 单例：路由要能拿到同一个登记表。 */
export const supersededRegistry = new SupersededRegistry()

let verdict: ProjectionVerdict | null = null

/** 最近一次注册的结果（/health 用）。 */
export const projectionVerdict = (): ProjectionVerdict | null => verdict

/**
 * 注册三类消息投影。永不抛错 —— 注册不上的确是可运行降级状态。
 *
 * @param sessions - 宿主 `ctx.sessions`（在我的 inject 列表里，直接可用）。
 */
export function installMessageProjections(sessions: unknown, registry: SupersededRegistry): ProjectionVerdict {
  const installed: string[] = []
  const skipped: { type: string; reason: string }[] = []

  const register = (holder: unknown, name: string): ((projection: unknown) => unknown) | undefined => {
    const record = typeof holder === 'object' && holder !== null ? (holder as Record<string, unknown>) : null
    const fn = record?.[name]
    return typeof fn === 'function' ? (fn as (projection: unknown) => unknown) : undefined
  }
  const callRegister = register(sessions, 'registerMessageProjection')
  if (!callRegister) {
    verdict = {
      installed: [],
      skipped: PROJECTED_TYPES.map((type: string) => ({ type, reason: 'sessions.registerMessageProjection 不存在' })),
      ready: false,
    }
    return verdict
  }

  for (const projection of createMessageProjections(registry)) {
    try {
      // **必须绑定 this 调用**：宿主持内部读 `this.projections` 判重。把方法取出来
      // 裸调会让 this 变成 undefined，然后被我的 try/catch 吞成"跳过"——
      // 真机上就这么静默失败过（三类全跳过、ready=false，却看不出原因）。
      callRegister.call(sessions, projection)
      installed.push(projection.type)
    } catch (error) {
      skipped.push({ type: projection.type, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  verdict = {
    installed,
    skipped,
    // 三类齐全才启用：半残状态会留下没有提问的回复，比不隐藏更糟。
    ready: installed.length === PROJECTED_TYPES.length,
  }
  return verdict
}

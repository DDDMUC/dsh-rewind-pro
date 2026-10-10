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

// 活动路径投影 —— **结论：这条路对消息类型是死的，本模块不再被启动路径调用。**
//
// 用宿主自己导出的 `foldSurface` 实测（tests/host/host-active-path-integration.test.ts）：
// 投影路径 `plan.kind === 'project'` 只写 `projectedMessages`，**不把 seq 加进
// `state.nodes`**（surface.js 的 applySurfacePlan）。而 user/message 这类事件本来
// 就走 `kind: 'append'` 分支把自己加进 nodes；一旦注册投影，就走 project 分支，
// 于是**整条消息从派生历史里消失** —— 不是"只删我点名的那条"，是全都没了。
//
// 投影机制真正服务的对象是"插件自有、没有内置追加路径"的事件类型
// （MESSAGE_PROJECTION_EVENT_TYPES = { image/offload }，由 dsh-compaction-image-offload
// 提供解释器）。对那类类型，没有投影宿主会直接抛错。
//
// 所以：本模块的注册函数保留（供那类自有类型使用），但**不**再对消息类型注册；
// /health 会把 activePath.ready 报成 false，明确说明"没在用"。
// "翻页只改指针"要落地，剩下的路是：遮蔽 + 重放，或自己驱动模型调用。

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
 * 注册三类消息投影。**仅供插件自有类型使用，不要再对 user/message /
 * assistant/message / tool/result 调用**（原因见文件头：会把这些消息整条
 * 从派生历史里删掉）。永不抛错 —— 注册不上是可运行降级状态。
 *
 * @param sessions - 宿主 `ctx.sessions`。
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

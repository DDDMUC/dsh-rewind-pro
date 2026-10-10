// 「被顶掉的版本」：让模型只看到当前选中的那条链。
//
// 宿主给了这条路，源码级依据（不是猜）：
//   * `SessionStore.registerMessageProjection` 只在"同一事件类型已被注册"时抛错
//     （dsh-session/lib/index.js:877）→ 插件可以接管 `user/message`。
//   * 折叠时**先**找插件投影；**投影没有点名**的 seq 会**回落**到内置解释器
//     （repair.js 的 planSurfaceEvent / deriveEventMessage）
//     → "只点名要删的、其余一律不管"本身就是天然的恒等投影。
//   * 投影返回 Map 里值为 `null` 的 seq，`deriveEventMessage` 返回 null → 该消息
//     从派生历史里消失。删除发生在**派生层**：不改日志、不遮蔽、不重放、日志不增长。
//
// 为什么要按**消息 id** 而不是按会话 + seq：宿主持给投影的 ctx 里**没有 sessionId**
// （只有 nodes/events/baseSeq/messages），而投影是全宿主范围的；seq 又是每个会话
// 各自编号的，跨会话必然撞号。用户消息带稳定的 `data.id`（实测：`{content, source,
// role, id}`），所以按 id 点名既精确又不可能误伤别人的对话。
//
// 相对"遮蔽 + 重放"的优势：日志不增长、翻回去零成本、随时翻。
// 代价（必须始终记住）：投影是**全宿主范围**的，所以默认恒等；且一旦被会话用过就
// 不能随意注销（宿主持注释："disposing makes sessions that used it refuse further
// derivation"），所以设计成**常驻**：插件只登记、不注销。

/** 宿主持给投影的上下文（repair.js 里 projection.project(event, ctx) 的形状）。 */
export interface ProjectionProjectInput {
  /** 当前 surface 上的节点 seq。 */
  nodes: readonly number[]
  /** 该前缀内的完整事件（按 seq 顺序）。 */
  events: readonly unknown[]
  /** 窗口首个事件的绝对 seq。 */
  baseSeq: number
  /** 已经投影出来的消息（seq → 消息）。 */
  messages: ReadonlyMap<number, unknown>
}

/** 一条插件拥有的消息投影（宿主 SessionMessageProjection 的最小形状）。 */
export interface UserMessageProjection {
  type: string
  project(event: ProjectedUserEvent, ctx: ProjectionProjectInput): Map<number, unknown>
}

/** 宿主传进来的事件。 */
export interface ProjectedUserEvent {
  seq: number
  type: string
  sessionId?: string
  /** `user/message` 的 data 本身就是派生消息，带稳定的 `id`；缺失按"放行"处理。 */
  data?: unknown
}

const RECORD = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

/** 事件的稳定消息 id；拿不到就返回 null（宁可放行，也不要按猜的 gg 删东西）。 */
const messageIdOf = (event: ProjectedUserEvent): string | null => {
  const data = RECORD(event.data)
  const id = data?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * 被顶掉的版本清单（按消息 id）。
 *
 * 只有客户端**明确标记**过的 id 才会被删；没标记的一律放行。
 */
export class SupersededRegistry {
  private readonly ids = new Set<string>()

  /** 标记一条消息已被顶掉（用户翻到了别的版本）。 */
  add(id: string): void {
    if (id !== '') this.ids.add(id)
  }

  /** 翻回某个版本时把它恢复回来。 */
  remove(id: string): void {
    this.ids.delete(id)
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  size(): number {
    return this.ids.size
  }

  clear(): void {
    this.ids.clear()
  }
}

/**
 * 造一个 `user/message` 的投影。
 *
 * 语义：**只点名被顶掉的**。命中 → `[[seq, null]]`（从派生历史删除）；
 * 没命中 / 没有 id / 不是 user/message → **不点名**（回落内置解释器，原样保留）。
 */
export function createUserMessageProjection(registry: SupersededRegistry): UserMessageProjection {
  return {
    type: 'user/message',
    project(event) {
      if (event.type !== 'user/message') return new Map()
      const id = messageIdOf(event)
      if (id === null || !registry.has(id)) return new Map()
      return new Map([[event.seq, null]])
    },
  }
}

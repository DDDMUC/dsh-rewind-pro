// 「被顶掉的版本」：让模型只看到当前选中的那条链。
//
// 宿主给了这条路，源码级依据（不是猜）：
//   * `SessionStore.registerMessageProjection` 只在"同一事件类型已被注册"时抛错
//     （dsh-session/lib/index.js:877）→ 插件可以接管消息事件的解释。
//   * 折叠时**先**找插件投影；**投影没有点名**的 seq 会**回落**到内置解释器
//     （repair.js 的 planSurfaceEvent / deriveEventMessage）
//     → "只点名要删的、其余一律不管"本身就是天然的恒等投影。
//   * 投影返回 Map 里值为 `null` 的 seq，`deriveEventMessage` 返回 null → 该消息
//     从派生历史里消失。删除发生在**派生层**：不改日志、不遮蔽、不重放、日志不增长。
//
// 为什么要按**消息 id** 而不是会话 + seq：宿主持给投影的 ctx 里**没有 sessionId**
// （只有 nodes/events/baseSeq/messages），而投影是全宿主范围的；seq 又是每个会话
// 各自编号的，跨会话必然撞号。实测消息带稳定 id：`user/message` 在 `data.id`，
// `assistant/message` / `tool/result` 在 `data.message.id`。
//
// 相对"遮蔽 + 重放"的优势：日志不增长、翻回去零成本、随时翻。
// 代价（必须始终记住）：投影是**全宿主范围**的，所以默认恒等；且一旦被会话用过就
// 不能随意注销（宿主持注释："disposing makes sessions that used it refuse further
// derivation"），所以设计成**常驻**：只登记、不注销。

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
export interface MessageProjection {
  type: string
  project(event: ProjectedEvent, ctx: ProjectionProjectInput): Map<number, unknown>
}

/** 宿主传进来的事件。 */
export interface ProjectedEvent {
  seq: number
  type: string
  sessionId?: string
  data?: unknown
}

const RECORD = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

/**
 * 取事件的稳定消息 id；取不到返回 null（上层据此放行）。
 *
 * 两种位置：`user/message` 的 id 在 `data.id`（因为 `deriveEventMessage` 对它
 * 直接 `return event.data`），其余消息事件在 `data.message.id`。
 */
export function messageIdOf(event: ProjectedEvent): string | null {
  const data = RECORD(event.data)
  if (!data) return null
  const direct = data.id
  if (typeof direct === 'string' && direct !== '') return direct
  const nested = RECORD(data.message)?.id
  if (typeof nested === 'string' && nested !== '') return nested
  return null
}

/** 这三类事件会产生模型消息；其余（turn/step 边界、日志记录）不走投影。 */
export const PROJECTED_TYPES = ['user/message', 'assistant/message', 'tool/result'] as const

/**
 * 被顶掉的版本清单：按会话登记，按 id 判定。
 *
 * `set` 是**覆盖**语义（客户端每次上报完整清单）——幂等，重传不会留下旧状态。
 */
export class SupersededRegistry {
  private readonly bySession = new Map<string, Set<string>>()

  /** 整体替换某会话的顶掉清单。 */
  set(sessionId: string, ids: readonly string[]): void {
    const clean = new Set(ids.filter((id) => typeof id === 'string' && id !== ''))
    this.bySession.set(sessionId, clean)
  }

  /** 取某会话的清单；没登记返回 null。 */
  get(sessionId: string): string[] | null {
    const found = this.bySession.get(sessionId)
    return found === undefined ? null : [...found]
  }

  /** 这个 id 是否被顶掉（全会话范围）。 */
  has(id: string): boolean {
    for (const set of this.bySession.values()) if (set.has(id)) return true
    return false
  }

  /** 取消某会话的登记（版本树被清掉时）。 */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  /** 已登记的会话数（诊断用）。 */
  sessions(): number {
    return this.bySession.size
  }

  /** 被顶掉的消息总数（诊断用）。 */
  size(): number {
    let total = 0
    for (const set of this.bySession.values()) total += set.size
    return total
  }
}

/**
 * 把一个用户消息 id 展开成它**那一整个回合**的消息 id。
 *
 * 为什么必须展开：只删用户的提问会把它后面的助手回复/工具结果留成**孤儿**
 * （一条没有提问的回复），模型看到的就是断裂的对话。所以点名一条用户消息，
 * 就要把它到"下一条用户消息"之前的消息事件一起点名。
 *
 * 规则：
 *   * 从命中那条用户消息开始，走到下一条 `user/message` 之前（含端点）为止；
 *   * 只收**有稳定 id 的**消息事件 —— 没有 id 的宁可放过，绝不连坐；
 *   * `turn/start|end`、`step/start|end` 这类边界不是消息，不收；
 *   * 多个入参各自展开，结果去重、保持日志顺序。
 */
export function expandToTurns(events: readonly ProjectedEvent[], userIds: readonly string[]): string[] {
  const wanted = new Set(userIds.filter((id) => id !== ''))
  if (wanted.size === 0) return []

  const isMessage = (type: string): boolean => (PROJECTED_TYPES as readonly string[]).includes(type)
  const collected: string[] = []
  const seen = new Set<string>()

  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event === undefined) continue
    const id = isMessage(event.type) ? messageIdOf(event) : null
    if (id === null || seen.has(id)) continue
    if (event.type !== 'user/message' || !wanted.has(id)) continue

    // 命中：从这一条开始，收到下一条用户消息之前
    seen.add(id)
    collected.push(id)
    for (let walk = index + 1; walk < events.length; walk++) {
      const next = events[walk]
      if (next === undefined) continue
      if (next.type === 'user/message') break
      if (!isMessage(next.type)) continue
      const nextId = messageIdOf(next)
      if (nextId === null || seen.has(nextId)) continue
      seen.add(nextId)
      collected.push(nextId)
    }
  }
  return collected
}

/**
 * 造一组消息事件的投影。
 *
 * 命中 → `[[seq, null]]`（从派生历史删除）；没命中 / 没有 id / 不是消息事件
 * → **不点名**（回落内置解释器，原样保留）。
 */
export function createMessageProjections(registry: SupersededRegistry): MessageProjection[] {
  return PROJECTED_TYPES.map((type) => ({
    type,
    project(event) {
      if (event.type !== type) return new Map()
      const id = messageIdOf(event)
      if (id === null || !registry.has(id)) return new Map()
      return new Map([[event.seq, null]])
    },
  }))
}

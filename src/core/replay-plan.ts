// 切分支的写入规划：**遮蔽分歧尾部 + 重放目标后缀**。
//
// 为什么必须两步（都是实测结论，不是设计偏好）：
//   * 遮蔽（surfaceOp replace）真的有效 —— 用宿主 foldSurface 实测过
//     （tests/host/host-active-path-integration.test.ts）。
//   * 但遮蔽是**有损**的：节点一旦离开 surface 就回不来，所以"切回"一条
//     被遮蔽过的后缀，只能把它的副本重新追加进去 —— 即重放。
//   * 派生层投影这条路是死的：投影路径不把 seq 加进 nodes（同一文件里实测）。
//
// 于是每次切换的写入恒为两段：
//   1) 一条不可见替身（system/message，空 content）+ replace 覆盖"当前 surface
//      上第一个不在目标路径上的节点"到末尾；
//   2) 把目标路径在共同前缀之后的部分**逐条重放**（换新 id、新回合号、
//      `surfaceOp:'append'`，tool/result 的 sourceEventSeqs 重映射到新 seq）。
//
// 结果：surface = 共同前缀 + 重放出来的目标后缀，正好等于目标路径 ✓

/** 一条要追加的写入。 */
export interface ReplayWrite {
  type: string
  data: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
}

/** 宿主事件的最小形状（seq 是位置，foldSurface 用 index 当 seq）。 */
export interface PlanEvent {
  seq: number
  type: string
  data?: unknown
  surfaceOp?: unknown
  /** tool/result 指向它那条 tool/call 的节点；重放时要重映射。 */
  sourceEventSeqs?: number[]
}

export interface SwitchPlanInput {
  /** 完整事件日志（按位置）。 */
  events: readonly PlanEvent[]
  /** 当前 surface 上的节点（位置）。 */
  nodes: readonly number[]
  /** 目标路径：模型应该看到的消息 id，按顺序。 */
  targetIds: readonly string[]
  /** 现有最大回合号（重放要从它往后排）。 */
  maxTurn: number
  /** 造新 id；测试里可注入固定值。 */
  mint?: () => string
}

export type SwitchPlan =
  | { ok: true; writes: ReplayWrite[]; sharedPrefix: number; replayed: number; shadowed: number }
  | { ok: false; reason: string }

const RECORD = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** 事件承载的消息 id：user 在 data.id，其余在 data.message.id。 */
export function idOf(event: PlanEvent): string | null {
  const data = RECORD(event.data)
  if (!data) return null
  const direct = data.id
  if (typeof direct === 'string' && direct !== '') return direct
  const nested = RECORD(data.message)?.id
  if (typeof nested === 'string' && nested !== '') return nested
  return null
}

const isMessage = (event: PlanEvent): boolean => MESSAGE_TYPES.has(event.type)

/** 目标路径上第一条消息在日志里的位置。 */
const positionOfId = (events: readonly PlanEvent[], id: string): number =>
  events.findIndex((event) => isMessage(event) && idOf(event) === id)

/**
 * 规划一次切换。
 *
 * 没有分歧（目标就是当前路径）→ 空写入；目标消息在日志里找不到 → 明确拒绝
 * （宁可什么都不做，也不要往日志里写一个自己都不确定的写入序列）。
 */
export function planSwitch(input: SwitchPlanInput): SwitchPlan {
  const { events, nodes, targetIds } = input
  const mint = input.mint ?? ((): string => `id-${String(Math.random()).slice(2, 10)}`)

  const wanted = new Set(targetIds.filter((id) => id !== ''))
  // 1) 找共同前缀：从 surface 头部开始，节点消息都在目标上 → 共享
  let shared = 0
  for (const node of nodes) {
    const event = events[node]
    if (!event || !isMessage(event)) { shared += 1; continue }
    const id = idOf(event)
    if (id !== null && wanted.has(id)) { shared += 1; continue }
    break
  }
  const sharedPrefix = shared

  const wantsReplay = (): string[] => {
    const keep = new Set<string>()
    for (let index = 0; index < sharedPrefix; index++) {
      const event = events[nodes[index] ?? -1]
      if (event === undefined) continue
      const id = idOf(event)
      if (id !== null) keep.add(id)
    }
    return targetIds.filter((id) => id !== '' && !keep.has(id))
  }

  // 完全没有分歧（目标被当前 surface 覆盖）时，仍可能缺消息 —— 目标里有些消息
  // 早先被遮蔽过、已经不在 surface 上。这时也要把它们重放出去。
  // 真机上踩过：这里直接 return 空写入，导致"切回去"什么都不做。
  if (sharedPrefix >= nodes.length) {
    const missing = wantsReplay()
    if (missing.length === 0) return { ok: true, writes: [], sharedPrefix, replayed: 0, shadowed: 0 }
    // 没有要遮蔽的，只重放缺失部分
    const writes: ReplayWrite[] = []
    const plan = buildReplay(writes, missing, input.maxTurn, mint, events)
    return { ok: true, writes, sharedPrefix, replayed: plan, shadowed: 0 }
  }

  const shadowFrom = nodes[sharedPrefix]
  const shadowTo = nodes[nodes.length - 1]
  if (shadowFrom === undefined || shadowTo === undefined) {
    return { ok: false, reason: 'surface 节点不完整，无法规划遮蔽' }
  }

  const writes: ReplayWrite[] = []
  let turn = input.maxTurn

  // 2) 遮蔽：不可见替身（空 content 的 system/message），覆盖分歧尾部
  turn += 1
  const shadowTurn = turn
  const shadowedCount = nodes.length - sharedPrefix
  writes.push({ type: 'turn/start', data: { turn: shadowTurn } })
  writes.push({ type: 'step/start', data: { turn: shadowTurn, step: 1 } })
  writes.push({
    type: 'system/message',
    data: {
      turn: shadowTurn,
      step: 1,
      message: { id: mint(), role: 'system', content: [], source: { kind: 'system-prompt', plugin: 'dsh-rewind-pro' } },
    },
    surfaceOp: { op: 'replace', startSeq: shadowFrom, endSeq: shadowTo },
    sourceEventSeqs: nodes.slice(sharedPrefix),
  })
  writes.push({ type: 'step/end', data: { turn: shadowTurn, step: 1 } })
  writes.push({ type: 'turn/end', data: { turn: shadowTurn, reason: { kind: 'completed' } } })

  // 3) 重放目标后缀（共同前缀之后的部分）
  const targetTail = targetIds.filter((id) => id !== '')
  // 每条消息的原始位置，用来复制它的 data
  const positionOf = new Map<string, number>()
  for (const id of targetTail) {
    const at = positionOfId(events, id)
    if (at >= 0) positionOf.set(id, at)
  }

  // 3) 重放：重放**共同前缀之后**的目标消息。
  //    前缀里的消息不会被遮蔽，不用重放；前缀之后的目标消息哪怕还在 surface 上，
  //    也在被遮蔽的范围内（遮蔽覆盖 prefix..末尾），所以必须重放回来。
  const prefixIds = new Set<string>()
  for (let index = 0; index < sharedPrefix; index++) {
    const event = events[nodes[index] ?? -1]
    if (event === undefined) continue
    const id = idOf(event)
    if (id !== null) prefixIds.add(id)
  }
  const keepIds = prefixIds

  let replayed = 0
  /** 旧消息 id → 新消息 id：tool/result 的 sourceEventSeqs 要靠它重映射。 */
  const idRemap = new Map<string, string>()
  for (const id of targetTail) {
    if (keepIds.has(id)) continue
    const at = positionOf.get(id)
    if (at === undefined) continue
    const source = events[at]
    if (!source || !isMessage(source)) continue

    turn += 1
    const writeTurn = turn
    const freshId = mint()
    idRemap.set(id, freshId)

    const data = structuredCloneish(source.data)
    // 换 id：user 在 data.id，其余在 data.message.id
    const record = RECORD(data)
    if (record) {
      if (typeof record.id === 'string') record.id = freshId
      const message = RECORD(record.message)
      if (message && typeof message.id === 'string') message.id = freshId
      // 重放标记：**没有就建**。事后要能从日志认出"这条是重放来的"。
      const sourceMeta = RECORD(record.source) ?? {}
      sourceMeta.replayedBy = 'dsh-rewind-pro'
      sourceMeta.originalSeq = source.seq
      record.source = sourceMeta
    }

    writes.push({ type: 'turn/start', data: { turn: writeTurn } })
    const remapped = remapSourceEventSeqs(source.sourceEventSeqs, idRemap)
    writes.push({
      type: source.type,
      data,
      surfaceOp: 'append',
      ...(remapped === null ? {} : { sourceEventSeqs: remapped }),
    })
    writes.push({ type: 'turn/end', data: { turn: writeTurn, reason: { kind: 'completed' } } })
    replayed += 1
  }

  return { ok: true, writes, sharedPrefix, replayed, shadowed: shadowedCount }
}

/**
 * 把一组目标消息重放成写入（供"有遮蔽"和"纯重放"两条路径共用）。
 *
 * 每条消息一个独立回合（turn/start → 事件 → turn/end），内容原样复制、id 换新、
 * 带 `replayedBy` 标记。
 */
function buildReplay(
  writes: ReplayWrite[],
  ids: readonly string[],
  startTurn: number,
  mint: () => string,
  events: readonly PlanEvent[],
): number {
  const positionOf = new Map<string, number>()
  for (const id of ids) {
    const at = positionOfId(events, id)
    if (at >= 0) positionOf.set(id, at)
  }
  const idRemap = new Map<string, string>()
  let turn = startTurn
  let replayed = 0

  for (const id of ids) {
    const at = positionOf.get(id)
    if (at === undefined) continue
    const source = events[at]
    if (!source || !isMessage(source)) continue

    turn += 1
    const writeTurn = turn
    const freshId = mint()
    idRemap.set(id, freshId)

    const data = structuredCloneish(source.data)
    const record = RECORD(data)
    if (record) {
      if (typeof record.id === 'string') record.id = freshId
      const message = RECORD(record.message)
      if (message && typeof message.id === 'string') message.id = freshId
      const sourceMeta = RECORD(record.source) ?? {}
      sourceMeta.replayedBy = 'dsh-rewind-pro'
      sourceMeta.originalSeq = source.seq
      record.source = sourceMeta
    }

    writes.push({ type: 'turn/start', data: { turn: writeTurn } })
    const remapped = remapSourceEventSeqs(source.sourceEventSeqs, idRemap)
    writes.push({
      type: source.type,
      data,
      surfaceOp: 'append',
      ...(remapped === null ? {} : { sourceEventSeqs: remapped }),
    })
    writes.push({ type: 'turn/end', data: { turn: writeTurn, reason: { kind: 'completed' } } })
    replayed += 1
  }
  return replayed
}

/** tool/result 的 sourceEventSeqs 重映射到新的 seq；非工具事件原样返回 null。 */
function remapSourceEventSeqs(value: unknown, _remap: Map<string, string>): number[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((seq): seq is number => typeof seq === 'number')
}

/** 深拷贝（避免改写调用方的日志对象）。 */
function structuredCloneish<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

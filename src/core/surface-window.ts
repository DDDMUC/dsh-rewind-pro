// Surface 窗口规划 —— "把这条消息到末尾"这一段从模型上下文里遮蔽掉。
//
// 这是 `dsh-rerun-turn` / `dsh-edit-turn` 共用的那套官方机制：会话日志是追加式的，
// 你**不能改历史**，但可以追加一个"替身"事件，它的 `surfaceOp` 是
// `{ op: 'replace', startSeq, endSeq }` —— 派生历史时被它覆盖的那些节点就被删掉了。
//
// 本模块只做纯计算（不碰宿主、可单测），照抄它们 `foldSurface` 的语义：
//   * `surfaceOp === 'append'`            → 这个事件进入 surface
//   * `surfaceOp` 是 replace              → 先把窗口内的节点删掉，再把**替身自己**算作节点
//   * 没有 surfaceOp 的事件（chunk、turn 边界）不属于 surface
//
// 于是"遮蔽窗口"就是：从被点的那条消息（它必须是 surface 节点）到**最后一个** surface
// 节点，连同中间所有节点一起交给 replace 的 `sourceEventSeqs`（DSH 要求带齐）。

export interface SurfaceEventLike {
  seq: number
  type: string
  surfaceOp?: unknown
  data?: unknown
}

export interface SurfaceFold {
  /** 当前 surface 上的节点 seq，按模型读到的顺序。 */
  nodes: number[]
  /** 用到的最大的回合号（合成记账回合要接着它往下排）。 */
  maxTurn: number
}

interface ReplaceOp {
  op: 'replace'
  startSeq: number
  endSeq: number
}

const asReplace = (op: unknown): ReplaceOp | null => {
  if (typeof op !== 'object' || op === null) return null
  const record = op as Record<string, unknown>
  if (record.op !== 'replace') return null
  const startSeq = record.startSeq
  const endSeq = record.endSeq
  if (typeof startSeq !== 'number' || typeof endSeq !== 'number') return null
  return { op: 'replace', startSeq, endSeq }
}

const turnOf = (event: SurfaceEventLike): number | null => {
  if (event.type !== 'turn/start' && event.type !== 'turn/end') return null
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const turn = (data as Record<string, unknown>).turn
  return typeof turn === 'number' ? turn : null
}

/** 走一遍事件日志，得到当前 surface 与最大回合号。 */
export function foldSurface(events: readonly SurfaceEventLike[]): SurfaceFold {
  const nodes: number[] = []
  let maxTurn = 0
  for (const event of events) {
    const turn = turnOf(event)
    if (turn !== null && turn > maxTurn) maxTurn = turn

    const op = event.surfaceOp
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    const replace = asReplace(op)
    if (!replace) continue
    // 被覆盖的节点出局，替身自己进表面
    for (let index = nodes.length - 1; index >= 0; index--) {
      const seq = nodes[index]
      if (seq !== undefined && seq >= replace.startSeq && seq <= replace.endSeq) nodes.splice(index, 1)
    }
    nodes.push(event.seq)
  }
  return { nodes, maxTurn }
}

export interface ShadowPlan {
  /** 窗口起点：被点的那条消息（必须是 surface 节点）。 */
  startSeq: number
  /** 窗口终点：最后一个 surface 节点。 */
  endSeq: number
  /** 要被遮蔽的 surface 节点（闭合区间内的全部），交给 replace 的 sourceEventSeqs。 */
  shadowed: number[]
  /** 合成记账回合占用的回合号。 */
  turn: number
}

export type ShadowPlanResult = { ok: true; plan: ShadowPlan } | { ok: false; reason: string }

/**
 * 规划一次遮蔽：从 `targetSeq` 到 surface 末尾。
 *
 * 目标不是 surface 节点时**明确拒绝**（例如它已经被更早的 replace 遮蔽掉了）——
 * 宁可什么都不做并说明原因，也不要往日志里写一个错误的窗口。
 */
export function planShadow(events: readonly SurfaceEventLike[], targetSeq: number): ShadowPlanResult {
  const { nodes, maxTurn } = foldSurface(events)
  if (nodes.length === 0) return { ok: false, reason: 'surface is empty' }
  if (!nodes.includes(targetSeq)) return { ok: false, reason: `seq ${String(targetSeq)} is not a surface node` }

  const endSeq = nodes[nodes.length - 1]
  if (endSeq === undefined) return { ok: false, reason: 'surface is empty' }
  const shadowed = nodes.filter((seq) => seq >= targetSeq && seq <= endSeq)
  if (shadowed.length === 0) return { ok: false, reason: 'nothing to shadow' }
  return { ok: true, plan: { startSeq: targetSeq, endSeq, shadowed, turn: maxTurn + 1 } }
}

/** 遮蔽完成后，日志里已有的最大回合号（合成回合已经用掉了 turn）。 */
export const turnAfterShadow = (maxTurn: number): number => maxTurn

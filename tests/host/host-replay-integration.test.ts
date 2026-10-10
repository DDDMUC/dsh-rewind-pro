// 切分支的**真集成验证**：用宿主自己的 foldSurface 折一遍
// "原日志 + planSwitch 产出的写入"，派生历史必须正好等于目标路径。
//
// 这是"翻页能来回翻"唯一可信的证据形式 —— 前面的单元测试只证明写入形状对，
// 这里证明**宿主认这些写入、并且结果就是我们要的那条链**。

import { describe, expect, it } from 'vitest'
import { planSwitch, type PlanEvent } from '../../src/core/replay-plan'

const SURFACE_URL =
  'file:///C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js'

type Surface = {
  foldSurface: (events: unknown[], projections?: unknown[]) => { nodes: number[]; projectedMessages: Map<number, unknown> }
  deriveEventMessage: (event: unknown, projected: Map<number, unknown>) => unknown
}

const load = async (): Promise<Surface> => (await import(/* @vite-ignore */ SURFACE_URL)) as Surface

const user = (seq: number, id: string, text: string): PlanEvent => ({
  seq,
  type: 'user/message',
  surfaceOp: 'append',
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const assistant = (seq: number, id: string, text: string): PlanEvent => ({
  seq,
  type: 'assistant/message',
  surfaceOp: 'append',
  data: { message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
})

/** 甲问/答甲 + 乙问/答乙 + 乙问改/答乙改（三条都在同一条线性日志里）。 */
const LOG: PlanEvent[] = [
  { seq: 0, type: 'system/message', surfaceOp: 'append', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }] } } },
  user(1, 'u1', '甲问'),
  assistant(2, 'a1', '答甲'),
  user(3, 'u2', '乙问'),
  assistant(4, 'a2', '答乙'),
  user(5, 'u2b', '乙问改'),
  assistant(6, 'a2b', '答乙改'),
]
const NODES = [0, 1, 2, 3, 4, 5, 6]

let counter = 0
const mint = (): string => `fresh-${String((counter += 1))}`

/** 把写入**接在给定日志后面**（日志是累积的，真实系统也是如此），再用宿主折叠。 */
const foldFrom = (
  surface: Surface,
  events: readonly PlanEvent[],
  writes: readonly { type: string; data: unknown; surfaceOp?: unknown; sourceEventSeqs?: number[] }[],
): { texts: string[]; nodes: number[] } => {
  const all = [...events, ...writes.map((write, index) => ({ ...write, seq: events.length + index }))]
  const folded = surface.foldSurface(all, [])
  const texts = folded.nodes
    .map((node) => folded.projectedMessages.get(node) ?? surface.deriveEventMessage(all[node], folded.projectedMessages))
    .map((message) => {
      const content = (message as { content?: unknown } | null)?.content
      if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? '').join('')
      return typeof content === 'string' ? content : ''
    })
    .filter((text) => text !== '')
  return { texts, nodes: folded.nodes }
}

describe('切分支：用宿主的 foldSurface 验结果', () => {
  it('从"乙问改"切回"乙问" → 派生历史正好是目标路径', async () => {
    const surface = await load()
    counter = 0
    const plan = planSwitch({ events: LOG, nodes: NODES, targetIds: ['sys', 'u1', 'a1', 'u2', 'a2'], maxTurn: 2, mint })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(foldFrom(surface, LOG, plan.writes).texts).toEqual(['system prompt', '甲问', '答甲', '乙问', '答乙'])
  })

  it('从"乙问"切到"乙问改"（老分支在 surface 前面）→ 也正好是目标路径', async () => {
    const surface = await load()
    counter = 0
    // 先制造"当前在乙问"的 surface：遮蔽 5..6
    const back = planSwitch({ events: LOG, nodes: NODES, targetIds: ['sys', 'u1', 'a1', 'u2', 'a2'], maxTurn: 2, mint })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    const afterBack = [...LOG, ...back.writes.map((write, index) => ({ ...write, seq: LOG.length + index }))]
    const foldedBack = surface.foldSurface(afterBack, [])
    // 替身是第 3 条写入（turn/start、step/start、**替身**、…），所以落在 index 9
    expect(foldedBack.nodes).toEqual([0, 1, 2, 3, 4, 9])

    // 再从"乙问"切到"乙问改"
    counter = 0
    const forward = planSwitch({
      events: afterBack,
      nodes: foldedBack.nodes,
      targetIds: ['sys', 'u1', 'a1', 'u2b', 'a2b'],
      maxTurn: 6,
      mint,
    })
    expect(forward.ok).toBe(true)
    if (!forward.ok) return

    const texts = foldFrom(surface, afterBack, forward.writes).texts
    expect(texts).toEqual(['system prompt', '甲问', '答甲', '乙问改', '答乙改'])
  })

  it('来回翻一次再翻回来：历史不漂移（幂等）', async () => {
    const surface = await load()
    // 乙问改 → 乙问 → 乙问改 → 乙问，每次都应得到正确的目标路径
    let events: PlanEvent[] = [...LOG]
    let nodes = NODES
    const targets = [
      ['sys', 'u1', 'a1', 'u2', 'a2'],
      ['sys', 'u1', 'a1', 'u2b', 'a2b'],
      ['sys', 'u1', 'a1', 'u2', 'a2'],
    ]
    const expected = [
      ['system prompt', '甲问', '答甲', '乙问', '答乙'],
      ['system prompt', '甲问', '答甲', '乙问改', '答乙改'],
      ['system prompt', '甲问', '答甲', '乙问', '答乙'],
    ]

    for (let round = 0; round < targets.length; round++) {
      counter = 0
      const plan = planSwitch({ events, nodes, targetIds: targets[round] as string[], maxTurn: 2 + round * 3, mint })
      expect(plan.ok).toBe(true)
      if (!plan.ok) return
      events = [...events, ...plan.writes.map((write, index) => ({ ...write, seq: events.length + index }))]
      const folded = surface.foldSurface(events, [])
      nodes = folded.nodes
      const texts = nodes
        .map((node) => folded.projectedMessages.get(node) ?? surface.deriveEventMessage(events[node], folded.projectedMessages))
        .map((message) => {
          const content = (message as { content?: unknown } | null)?.content
          if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? '').join('')
          return typeof content === 'string' ? content : ''
        })
        .filter((text) => text !== '')
      expect(texts).toEqual(expected[round])
    }
  })
})

/**
 * 用宿主自己的折叠代码（`dsh-session` 的 surface 导出）验两件事：
 *
 *   1. **遮蔽（surfaceOp replace）真的有效**：替身把窗口内的节点从派生历史删掉。
 *   2. **投影（registerMessageProjection）对消息类型是死的**：投影路径不把 seq
 *      加进 surface 节点，所以对本来走"追加"路径的 user/message 注册投影，
 *      会让这些消息**整条消失**（不是只删点名的那条）。
 *
 * 第 2 条是这条测试存在的理由：它用宿主自己的代码证明"翻页只改指针"这条路
 * 走不通，省得再把同样的期望写进产品代码里。
 *
 * 为什么用绝对路径导入：harness 装在本机 node_modules 下，不是本仓库依赖；
 * 这是集成测试，导入真实实现比导入一份拷贝更接近真相。
 */

import { describe, expect, it } from 'vitest'
import { SupersededRegistry, createMessageProjections } from '../../src/core/active-path'

// 宿主自己的折叠代码在 `dsh-session` 的 `surface` 导出里（不是 repair.js）
const REPAIR_URL =
  'file:///C:/Program Files/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js'

type Repair = {
  foldSurface: (events: unknown[], projections?: unknown[]) => { nodes: number[]; projectedMessages: Map<number, unknown> }
  deriveEventMessage: (event: unknown, projected: Map<number, unknown>) => unknown
}

const load = async (): Promise<Repair> => (await import(/* @vite-ignore */ REPAIR_URL)) as Repair

const userEvent = (seq: number, id: string, text: string) => ({
  seq,
  type: 'user/message',
  surfaceOp: 'append',
  data: { id, role: 'user', content: [{ type: 'text', text }] },
})
const assistantEvent = (seq: number, id: string, text: string) => ({
  seq,
  type: 'assistant/message',
  surfaceOp: 'append',
  data: { message: { id, role: 'assistant', content: [{ type: 'text', text }] } },
})

/**
 * 一条两轮对话：甲问/答甲 + 乙问/答乙。
 *
 * 事件形状按宿主真实的来：`user/message` 的消息体就是 `data`（含 id）；
 * 其余消息事件（system / assistant / tool）放在 `data.message` 里 —— 这是宿主
 * `deriveEventMessage` 的真实读法，合成数据写错会被它当场抛出来（踩过）。
 */
const LOG = [
  {
    seq: 0,
    type: 'system/message',
    surfaceOp: 'append',
    data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }] } },
  },
  userEvent(1, 'u1', '甲问'),
  assistantEvent(2, 'a1', '答甲'),
  userEvent(3, 'u2', '乙问'),
  assistantEvent(4, 'a2', '答乙'),
]

const texts = (repair: Repair, nodes: number[], projected: Map<number, unknown>): string[] =>
  nodes
    .map((seq) => LOG[seq])
    .filter(Boolean)
    .map((event) => {
      const message = repair.deriveEventMessage(event, projected) as { content?: unknown } | null
      if (message === null || message === undefined) return ''
      const content = message.content
      if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? '').join('')
      return typeof content === 'string' ? content : ''
    })
    .filter((text) => text !== '')

describe('用宿主自己的 foldSurface 验投影（真集成）', () => {
  it('什么都没顶掉 → 派生历史完整（含系统提示）', async () => {
    const repair = await load()
    const folded = repair.foldSurface(LOG, [])
    expect(texts(repair, folded.nodes, folded.projectedMessages)).toEqual([
      'system prompt',
      '甲问',
      '答甲',
      '乙问',
      '答乙',
    ])
  })

  it('【旧期望，已作废】投影不会"只删点名的那条"——宿主把整类消息都收走了', async () => {
    // 保留这条是为了让变化在 Git 历史里可见：原来期待
    //   ['system prompt', '甲问', '答甲']
    // 实测是 ['system prompt'] —— **整个类型**的消息都被收走。
    const repair = await load()
    const registry = new SupersededRegistry()
    registry.set('s1', ['u2', 'a2'])
    const folded = repair.foldSurface(LOG, createMessageProjections(registry))
    expect(texts(repair, folded.nodes, folded.projectedMessages)).toEqual(['system prompt'])
  })

  it('只顶掉提问、不展开会怎样 —— 投影这条路本来就不通（记录在案）', async () => {
    const repair = await load()
    const registry = new SupersededRegistry()
    registry.set('s1', ['u2'])
    const folded = repair.foldSurface(LOG, createMessageProjections(registry))
    // 同样原因：整类被收走，谈不上"孤儿回复"。
    expect(texts(repair, folded.nodes, folded.projectedMessages)).toEqual(['system prompt'])
  })

  it('翻回去也不能恢复 —— 投影按**类型**接管，与名单无关（记录在案）', async () => {
    const repair = await load()
    const registry = new SupersededRegistry()
    registry.set('s1', ['u2', 'a2'])
    const projections = createMessageProjections(registry)
    const folded1 = repair.foldSurface(LOG, projections)
    expect(texts(repair, folded1.nodes, folded1.projectedMessages)).toEqual(['system prompt'])

    registry.set('s1', [])
    const folded2 = repair.foldSurface(LOG, projections)
    expect(texts(repair, folded2.nodes, folded2.projectedMessages)).toEqual(['system prompt'])
  })

  it('遮蔽（surfaceOp replace）真的有效：替身把窗口内节点从派生历史删掉', async () => {
    const repair = await load()
    // 在末尾追加一个 replace 替身，盖住 seq 3..4（乙问/答乙）
    const withShadow = [
      ...LOG,
      {
        seq: 5,
        type: 'system/message',
        surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 },
        sourceEventSeqs: [3, 4],
        data: { message: { id: 'c1', role: 'system', content: [] } },
      },
    ]
    const folded = repair.foldSurface(withShadow, [])
    expect(texts(repair, folded.nodes, folded.projectedMessages)).toEqual(['system prompt', '甲问', '答甲'])
  })

  it('【结论】对消息类型注册投影 = 这些消息整条消失（不是只删点名的那条）', async () => {
    // 这就是"翻页只改指针"走不通的实证：投影路径（plan.kind === 'project'）
    // 只写 projectedMessages，**不把 seq 加进 nodes**；而 user/message 本来走
    // append 分支把自己加进 nodes。注册投影后它们全部掉出派生历史。
    const repair = await load()
    const registry = new SupersededRegistry()
    registry.set('s1', ['u2', 'a2']) // 只想顶掉"乙问"那一轮
    const folded = repair.foldSurface(LOG, createMessageProjections(registry))

    // 实际结果：连甲问/答甲一起没了，只剩系统提示
    expect(texts(repair, folded.nodes, folded.projectedMessages)).toEqual(['system prompt'])
    // 证据：被投影的类型全部不在 nodes 里（nodes 只剩系统提示那一帧）
    for (const seq of [1, 2, 3, 4]) {
      expect(folded.nodes).not.toContain(seq)
    }
    expect(folded.nodes).toEqual([0])
  })

  it('【推论】所以翻页不能靠投影；能用的只有遮蔽 + 重放，或自己驱动模型调用', async () => {
    // 把结论钉在仓库里：后来者想再走"派生层过滤"，先看这一条与上一条。
    const repair = await load()
    const folded = repair.foldSurface(LOG, [])
    expect(folded.nodes).toEqual([0, 1, 2, 3, 4])
  })
})

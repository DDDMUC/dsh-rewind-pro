// 行为规格：一轮 = 输入版本链 × 回复版本链；前缀保留、后缀整条跟着选中版本走；
// 编辑/重跑开新分支、旧后缀原地保留（翻页可回）；生成上下文只带当前路径。

import { describe, expect, it } from 'vitest'
import {
  appendTurn,
  branchPath,
  commitUserEdit,
  contextMessages,
  emptyConversation,
  isOnPath,
  normalizeConversation,
  pathIndexOf,
  rerunReply,
  serializeConversation,
  deserializeConversation,
  switchInput,
  switchReply,
  type Conversation,
} from '../../src/core/branch'

/** 两轮对话：甲问 → r-甲1 → 乙问 → r-乙1 */
function twoTurns(): Conversation {
  let conversation = emptyConversation()
  conversation = appendTurn(conversation, '甲问')
  conversation = rerunReply(conversation, 't1', 'r-甲1')
  conversation = appendTurn(conversation, '乙问')
  conversation = rerunReply(conversation, 't2', 'r-乙1')
  return conversation
}

const texts = (conversation: Conversation): string[] =>
  contextMessages(conversation, 0).map((message) => message.text)

const userTexts = (conversation: Conversation): string[] =>
  contextMessages(conversation, 0)
    .filter((message) => message.role === 'user')
    .map((message) => message.text)

describe('分支路径', () => {
  it('把两轮串成一条路径', () => {
    const conversation = twoTurns()
    expect(branchPath(conversation).map((node) => node.input.text)).toEqual(['甲问', '乙问'])
    expect(pathIndexOf(conversation, 't2')).toBe(1)
    expect(isOnPath(conversation, 't1')).toBe(true)
  })

  it('只沿当前分支取上下文', () => {
    expect(texts(twoTurns())).toEqual(['甲问', 'r-甲1', '乙问', 'r-乙1'])
  })

  it('限制条数时取最近 N 条', () => {
    expect(contextMessages(twoTurns(), 2).map((message) => message.text)).toEqual(['乙问', 'r-乙1'])
  })
})

describe('编辑用户输入 = 追加输入版本', () => {
  it('前缀保留、后缀整条换新；翻回旧版本旧后缀还在', () => {
    const conversation = twoTurns()
    const edited = commitUserEdit(conversation, 't1', '甲问改')

    // 新输入版本还没有回复 → 新分支上只剩第一轮
    expect(userTexts(edited)).toEqual(['甲问改'])
    expect(branchPath(edited)).toHaveLength(1)
    // 旧输入版本连同它后面的整条后缀都还在
    expect(branchPath(edited)[0].turn.inputs).toHaveLength(2)

    const back = switchInput(edited, 't1', 0)
    expect(userTexts(back)).toEqual(['甲问', '乙问'])
    expect(texts(back)).toEqual(['甲问', 'r-甲1', '乙问', 'r-乙1'])
  })

  it('在新分支上继续，不会碰到旧枝', () => {
    let conversation = commitUserEdit(twoTurns(), 't1', '甲问改')
    conversation = rerunReply(conversation, 't1', 'r-甲改')
    conversation = appendTurn(conversation, '丙问')

    expect(userTexts(conversation)).toEqual(['甲问改', '丙问'])
    expect(texts(conversation)).not.toContain('乙问')
    expect(texts(conversation)).not.toContain('r-乙1')

    const back = switchInput(conversation, 't1', 0)
    expect(userTexts(back)).toEqual(['甲问', '乙问'])
  })
})

describe('重跑 = 追加回复版本', () => {
  it('新后缀跟新回复走；翻回旧回复老后缀整条回来', () => {
    const conversation = twoTurns()
    const rerun = rerunReply(conversation, 't1', 'r-甲2')

    // 新回复的 next 为空 → 新分支上没有第二轮
    expect(userTexts(rerun)).toEqual(['甲问'])
    expect(texts(rerun)).toEqual(['甲问', 'r-甲2'])

    // 在新分支上继续
    let continued = appendTurn(rerun, '丙问')
    continued = rerunReply(continued, 't3', 'r-丙1')
    expect(userTexts(continued)).toEqual(['甲问', '丙问'])
    expect(texts(continued)).not.toContain('r-甲1')
    expect(texts(continued)).not.toContain('乙问')

    // 翻回回复 1/2：老后缀（乙问 + 它的回复）回来，第一轮回复也切回旧版
    const back = switchReply(continued, 't1', 0)
    expect(texts(back)).toEqual(['甲问', 'r-甲1', '乙问', 'r-乙1'])
    expect(texts(back)).not.toContain('r-甲2')
    expect(texts(back)).not.toContain('丙问')
  })

  it('前端还没有回复时无处可挂新一轮', () => {
    let conversation = emptyConversation()
    conversation = appendTurn(conversation, '甲问')
    const unchanged = appendTurn(conversation, '乙问')
    expect(userTexts(unchanged)).toEqual(['甲问'])
  })
})

describe('迁移', () => {
  it('把无版本号的 messages 线性列表包成单链，且一条都不丢', () => {
    const conversation = normalizeConversation({
      messages: [
        { role: 'user', text: '一' },
        { role: 'assistant', text: 'A' },
        { role: 'user', text: '二' },
        { role: 'assistant', text: 'B' },
      ],
    })
    expect(texts(conversation)).toEqual(['一', 'A', '二', 'B'])
    expect(branchPath(conversation)).toHaveLength(2)
    // 单链每轮只有一个版本，翻页仍可回（页码 1/1）
    expect(branchPath(conversation)[0].turn.inputs).toHaveLength(1)
    expect(branchPath(conversation)[0].input.replies).toHaveLength(1)
  })

  it('把 turns 形态也串成单链', () => {
    const conversation = normalizeConversation({ turns: [{ input: '问一', reply: '答一' }, { input: '问二', reply: '答二' }] })
    expect(texts(conversation)).toEqual(['问一', '答一', '问二', '答二'])
  })

  it('越界索引与缺失字段不会让路径断掉', () => {
    const conversation = normalizeConversation({
      root: { id: 't1', selectedInput: 9, inputs: [{ id: 't1-i0', text: '一', selectedReply: 9, replies: [{ id: 'r0', text: 'A' }] }] },
    })
    expect(texts(conversation)).toEqual(['一', 'A'])
  })

  it('序列化再读回来是同一棵树', () => {
    const conversation = rerunReply(twoTurns(), 't1', 'r-甲2')
    const round = deserializeConversation(serializeConversation(conversation))
    expect(texts(round)).toEqual(texts(conversation))
    // 重跑加的是回复版本：输入仍是 1 个，回复变成 2 个，且都活着
    expect(branchPath(round)[0].turn.inputs).toHaveLength(1)
    expect(branchPath(round)[0].input.replies).toHaveLength(2)
  })

  it('空数据不炸', () => {
    expect(branchPath(normalizeConversation(undefined))).toEqual([])
    expect(branchPath(normalizeConversation(null))).toEqual([])
  })
})

describe('不可变', () => {
  it('变更函数不改传入的对象', () => {
    const conversation = twoTurns()
    const snapshot = JSON.stringify(serializeConversation(conversation))

    commitUserEdit(conversation, 't1', '改了')
    rerunReply(conversation, 't1', 'r2')
    switchInput(conversation, 't1', 0)
    switchReply(conversation, 't1', 0)
    appendTurn(conversation, '新的')

    expect(JSON.stringify(serializeConversation(conversation))).toBe(snapshot)
  })

  it('翻页越界时原样返回', () => {
    const conversation = twoTurns()
    expect(switchInput(conversation, 't1', 5)).toBe(conversation)
    expect(switchReply(conversation, 't1', 5)).toBe(conversation)
  })
})

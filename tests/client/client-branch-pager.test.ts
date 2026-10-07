// 翻页器的行为规格（happy-dom）：控件要出现在行里、翻页要真的让后缀行消失与回来。
//
// 这里刻意用一段"假的聊天 DOM"（只保留 DSH 真实 DOM 里被依赖的那些属性：
// data-chat-flow-kind 与承载文本的容器），因为翻页器的可见效果正是靠这两样实现的。

import { beforeEach, describe, expect, it } from 'vitest'
import { mountBranchPager, type BranchPagerHandle } from '../../src/client/branch-pager'

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

/** 两轮对话的 DOM：用户行 + 它后面的助手行。 */
function chatDom(): void {
  document.body.innerHTML = [
    '<div data-chat-flow-kind="user"><button aria-label="edit"></button><span data-message-text>甲问</span></div>',
    '<div data-chat-flow-kind="assistant-step"><span data-message-text>答甲</span></div>',
    '<div data-chat-flow-kind="user"><button aria-label="edit"></button><span data-message-text>乙问</span></div>',
    '<div data-chat-flow-kind="assistant-step"><span data-message-text>答乙</span></div>',
  ].join('')
}

const userRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="user"]'))
const assistantRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="assistant-step"]'))
const pagerIn = (row: HTMLElement): HTMLElement | null => row.querySelector<HTMLElement>('.dsh-rewind-pro-pager')
const buttonByTitle = (row: HTMLElement, title: string): HTMLButtonElement | null =>
  row.querySelector<HTMLButtonElement>(`.dsh-rewind-pro-pager button[title="${title}"]`)
const visible = (element: HTMLElement): boolean => element.style.display !== 'none'

describe('版本树翻页器', () => {
  let handle: BranchPagerHandle | null = null
  let storage = fakeStorage()

  beforeEach(() => {
    handle?.dispose()
    handle = null
    storage = fakeStorage()
    chatDom()
  })

  const mount = (askText?: (current: string) => string | null): BranchPagerHandle => {
    handle = mountBranchPager({
      sessionId: () => 'session-1',
      doc: document,
      storage,
      readText: (row) => row.querySelector('[data-message-text]')?.textContent?.trim() ?? '',
      askText: askText ?? (() => null),
    })
    return handle
  }

  /** 翻页器上显示的 "n/N"（按输入/回复两条链分别取）。 */
  const countIn = (row: HTMLElement, label: '输入' | '回复'): string | null =>
    row
      .querySelector(`.dsh-rewind-pro-pager-stepper[title^="${label}版本"] .dsh-rewind-pro-pager-count`)
      ?.textContent?.trim() ?? null

  it('把控件注入到每一个用户行里', () => {
    mount()
    for (const row of userRows()) expect(pagerIn(row)).not.toBeNull()
    // 单版本时**不摆** 1/1（那是噪声，还会把动作区撑长），只留两个图标动作；
    // 文字都在 title / aria-label 里，可读性不丢。
    expect(pagerIn(userRows()[0])?.querySelector('[title="上一条输入版本"]')).toBeNull()
    expect(pagerIn(userRows()[0])?.querySelector('[title="上一条回复版本"]')).toBeNull()
    expect(pagerIn(userRows()[0])?.querySelector('button[aria-label="编辑"]')).not.toBeNull()
    expect(pagerIn(userRows()[0])?.querySelector('button[aria-label="重跑"]')).not.toBeNull()
  })

  it('编辑开新输入版本：新输入没有回复，后缀行消失；翻回去它们回来', () => {
    const pager = mount(() => '甲问改')

    buttonByTitle(userRows()[0], '以这条为起点开一个新输入版本')?.click()
    pager.refresh()

    // 新输入版本成为当前 → 输入 2/2，且第二轮整条隐藏
    expect(countIn(userRows()[0], '输入')).toBe('2/2')
    expect(visible(userRows()[1])).toBe(false)
    expect(visible(assistantRows()[1])).toBe(false)

    // 翻回上一条输入版本 → 旧后缀（乙问 + 它的回复）重新显示
    buttonByTitle(userRows()[0], '上一条输入版本')?.click()
    pager.refresh()
    expect(countIn(userRows()[0], '输入')).toBe('1/2')
    expect(visible(userRows()[1])).toBe(true)
    expect(visible(assistantRows()[1])).toBe(true)
  })

  it('重跑开新回复版本：后缀行消失；翻回旧回复它们回来', () => {
    const pager = mount()

    buttonByTitle(userRows()[0], '给这条回复再生成一个版本（新分支）')?.click()
    pager.refresh()

    expect(countIn(userRows()[0], '回复')).toBe('2/2')
    expect(visible(userRows()[1])).toBe(false)

    buttonByTitle(userRows()[0], '上一条回复版本')?.click()
    pager.refresh()
    expect(countIn(userRows()[0], '回复')).toBe('1/2')
    expect(visible(userRows()[1])).toBe(true)
    expect(visible(assistantRows()[1])).toBe(true)
  })

  it('渐进渲染：后出现的行不会被当成历史而隐藏（真机踩过的 bug）', () => {
    // 真实界面是一点点渲染出来的：第一次 refresh 可能只看到第一轮
    document.body.innerHTML =
      '<div data-chat-flow-kind="user"><span data-message-text>甲问</span></div>' +
      '<div data-chat-flow-kind="assistant-step"><span data-message-text>答甲</span></div>'
    const pager = mount()
    pager.refresh()
    expect(userRows()).toHaveLength(1)

    // 第二轮随后渲染出来
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div data-chat-flow-kind="user"><span data-message-text>乙问</span></div>' +
        '<div data-chat-flow-kind="assistant-step"><span data-message-text>答乙</span></div>',
    )
    pager.refresh()

    expect(userRows()).toHaveLength(2)
    // 两行都必须在场：旧实现把后出现的行判成"不在分支上"而藏掉
    expect(visible(userRows()[0])).toBe(true)
    expect(visible(userRows()[1])).toBe(true)
    // 也不该冒出谁都没创建过的第二版本
    expect(countIn(userRows()[1], '回复')).toBeNull()
    expect(countIn(userRows()[0], '回复')).toBeNull()
  })

  it('"加载更早"插到顶部的行：我们不碰它（只隐藏自己确凿映射过的）', () => {
    const pager = mount()
    pager.refresh()
    document.body.insertAdjacentHTML('afterbegin', '<div data-chat-flow-kind="user"><span data-message-text>更早</span></div>')
    pager.refresh()

    expect(userRows()).toHaveLength(3)
    expect(visible(userRows()[0])).toBe(true)
    expect(visible(userRows()[1])).toBe(true)
    expect(pagerIn(userRows()[0])).toBeNull() // 没映射 → 不给它装控件，也不动它的显示
  })

  it('会话 id 中途变化（unknown → 真实 id）时不藏消息、不留幽灵版本', () => {
    // 真实界面里 sessionId() 一开始可能还是空的/unknown，稍后才解析出真 id。
    // key 一变就必须重建绑定，否则旧 turnId 留在绑定里 → 行被判成"不在分支上"
    // 而隐藏，重绑过程还会再造一个版本。
    let sid = 'unknown'
    handle = mountBranchPager({
      sessionId: () => sid,
      doc: document,
      storage,
      readText: (row) => row.querySelector('[data-message-text]')?.textContent?.trim() ?? '',
      askText: () => null,
    })
    handle.refresh()
    expect(visible(userRows()[0])).toBe(true)

    sid = 'session-1'
    handle.refresh()

    expect(userRows()).toHaveLength(2)
    for (const row of userRows()) expect(visible(row)).toBe(true)
    expect(countIn(userRows()[0], '回复')).toBeNull()
    expect(countIn(userRows()[1], '回复')).toBeNull()
  })

  it('模型按会话存进 storage，重新挂载后仍是分支状态', () => {
    const pager = mount(() => '甲问改')
    buttonByTitle(userRows()[0], '以这条为起点开一个新输入版本')?.click()
    pager.refresh()
    pager.dispose()
    handle = null

    chatDom()
    const again = mount()
    again.refresh()
    expect(countIn(userRows()[0], '输入')).toBe('2/2')
    expect(visible(userRows()[1])).toBe(false)
  })

  it('dispose 后控件被移除', () => {
    const pager = mount()
    pager.dispose()
    handle = null
    expect(document.querySelector('.dsh-rewind-pro-pager')).toBeNull()
  })
})

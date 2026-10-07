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

  it('把控件注入到每一个用户行里', () => {
    mount()
    for (const row of userRows()) expect(pagerIn(row)).not.toBeNull()
    // 单链：两个翻页器都只有 1/1
    expect(pagerIn(userRows()[0])?.textContent).toContain('输入 1/1')
    expect(pagerIn(userRows()[0])?.textContent).toContain('回复 1/1')
  })

  it('编辑开新输入版本：新输入没有回复，后缀行消失；翻回去它们回来', () => {
    const pager = mount(() => '甲问改')

    buttonByTitle(userRows()[0], '以这条为起点开一个新输入版本')?.click()
    pager.refresh()

    // 新输入版本成为当前 → 输入 2/2，且第二轮整条隐藏
    expect(pagerIn(userRows()[0])?.textContent).toContain('输入 2/2')
    expect(visible(userRows()[1])).toBe(false)
    expect(visible(assistantRows()[1])).toBe(false)

    // 翻回上一条输入版本 → 旧后缀（乙问 + 它的回复）重新显示
    buttonByTitle(userRows()[0], '上一条输入版本')?.click()
    pager.refresh()
    expect(pagerIn(userRows()[0])?.textContent).toContain('输入 1/2')
    expect(visible(userRows()[1])).toBe(true)
    expect(visible(assistantRows()[1])).toBe(true)
  })

  it('重跑开新回复版本：后缀行消失；翻回旧回复它们回来', () => {
    const pager = mount()

    buttonByTitle(userRows()[0], '给这条回复再生成一个版本（新分支）')?.click()
    pager.refresh()

    expect(pagerIn(userRows()[0])?.textContent).toContain('回复 2/2')
    expect(visible(userRows()[1])).toBe(false)

    buttonByTitle(userRows()[0], '上一条回复版本')?.click()
    pager.refresh()
    expect(pagerIn(userRows()[0])?.textContent).toContain('回复 1/2')
    expect(visible(userRows()[1])).toBe(true)
    expect(visible(assistantRows()[1])).toBe(true)
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
    expect(pagerIn(userRows()[0])?.textContent).toContain('输入 2/2')
    expect(visible(userRows()[1])).toBe(false)
  })

  it('dispose 后控件被移除', () => {
    const pager = mount()
    pager.dispose()
    handle = null
    expect(document.querySelector('.dsh-rewind-pro-pager')).toBeNull()
  })
})

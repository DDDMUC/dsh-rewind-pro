// 翻页器的行为规格（happy-dom）：控件要出现在行里、翻页要真的让后缀行消失与回来。
//
// 这里刻意用一段"假的聊天 DOM"（只保留 DSH 真实 DOM 里被依赖的那些属性：
// data-chat-flow-kind 与承载文本的容器），因为翻页器的可见效果正是靠这两样实现的。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountBranchPager, type BranchPagerHandle, type BranchPagerOptions } from '../../src/client/branch-pager'

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

const countInTop = (row: HTMLElement, label: '输入' | '回复'): string | null =>
  row
    .querySelector(`.dsh-rewind-pro-pager-stepper[title^="${label}版本"] .dsh-rewind-pro-pager-count`)
    ?.textContent?.trim() ?? null

const editViaTop = (row: HTMLElement, text: string): void => {
  buttonByTitle(row, '以这条为起点开一个新输入版本')?.click()
  const editor = document.querySelector<HTMLElement>('.dshet-editor')
  const area = editor?.querySelector('textarea')
  if (area) area.value = text
  const submit = Array.from(editor?.querySelectorAll('button') ?? []).find(
    (candidate) => (candidate.textContent ?? '').trim() === '分页重跑',
  )
  ;(submit as HTMLButtonElement | undefined)?.click()
}

describe('分页重跑接宿主（真的改提示词 + 真的重跑）', () => {
  let handle: BranchPagerHandle | null = null
  let storage = fakeStorage()
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    handle?.dispose()
    handle = null
    storage = fakeStorage()
    chatDom()
  })

  const mountWith = (extra: Partial<BranchPagerOptions>): void => {
    handle = mountBranchPager({
      sessionId: () => 'session-1',
      doc: document,
      storage,
      readText: (row) => row.querySelector('[data-message-text]')?.textContent?.trim() ?? '',
      askText: () => null,
      ...extra,
    })
  }

  const errorText = (): string => document.querySelector('.dshet-error')?.textContent?.trim() ?? ''

  it('定位不到时把**具体原因**显示出来（例如「这条太早，超出宿主能定位的范围」）', async () => {
    // 真机上踩过：用户点了会话最早的一条消息，而宿主只给最近 20 条候选，
    // 于是定位不到。这时必须说清是"太早"，而不是笼统一句"定位不到"。
    mountWith({
      seqOfRow: () => ({ reason: '这条消息太早，超出了宿主能定位的范围（只覆盖最近的 20 条用户消息）。' }),
      applyBranch: async () => ({ ok: true }),
    })

    editViaTop(userRows()[0], '甲问改')
    await tick()

    expect(errorText()).toContain('太早')
    expect(document.querySelector('.dshet-editor')).not.toBeNull()
  })

  it('成功：先把行定位成 seq，再带新文本调用宿主；成功才关编辑器', async () => {
    const calls: { seq: number; text: string }[] = []
    mountWith({
      seqOfRow: () => 7,
      applyBranch: async (input) => {
        calls.push(input)
        return { ok: true }
      },
    })

    editViaTop(userRows()[0], '甲问改')
    await tick()

    expect(calls).toEqual([{ seq: 7, text: '甲问改' }])
    expect(document.querySelector('.dshet-editor')).toBeNull()
  })

  it('定位不到 seq 就绝不动手，并把原因显示出来（猜 seq 会改错消息）', async () => {
    let called = 0
    mountWith({
      seqOfRow: () => null,
      applyBranch: async () => {
        called++
        return { ok: true }
      },
    })

    editViaTop(userRows()[0], '甲问改')
    await tick()

    expect(called).toBe(0)
    expect(document.querySelector('.dshet-editor')).not.toBeNull()
    expect(errorText()).toContain('定位')
  })

  it('宿主失败：原因显示出来，且**不改我自己的模型**（不假装成功）', async () => {
    mountWith({
      seqOfRow: () => 7,
      applyBranch: async () => ({ ok: false, reason: 'stale: expected seq 5, found 7' }),
    })

    editViaTop(userRows()[0], '甲问改')
    await tick()

    expect(errorText()).toContain('stale')
    expect(document.querySelector('.dshet-editor')).not.toBeNull()
    // 输入链必须还是 1 个版本：失败时不许在本地造出一个"假分支"
    expect(countInTop(userRows()[0], '输入')).toBeNull()
  })

  // 不清理就会带着一个还活着的翻页器进入下一个 describe，去干扰那边的用例
  afterEach(() => {
    handle?.dispose()
    handle = null
  })

  it('没接宿主通道时退回纯本地分页（老行为不能丢）', async () => {
    mountWith({})

    editViaTop(userRows()[0], '甲问改')
    await tick()

    expect(countInTop(userRows()[0], '输入')).toBe('2/2')
    expect(document.querySelector('.dshet-editor')).toBeNull()
  })
})

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

  /** 走我的行内编辑器：点笔 → 填文本 → 点【分页重跑】。 */
  const editVia = (row: HTMLElement, text: string): void => {
    buttonByTitle(row, '以这条为起点开一个新输入版本')?.click()
    const editor = document.querySelector<HTMLElement>('.dshet-editor')
    expect(editor).not.toBeNull()
    const area = editor?.querySelector('textarea')
    if (area) area.value = text
    const submit = Array.from(editor?.querySelectorAll('button') ?? []).find(
      (candidate) => (candidate.textContent ?? '').trim() === '分页重跑',
    )
    ;(submit as HTMLButtonElement | undefined)?.click()
  }

  const footerLabels = (editor: HTMLElement | null): string[] =>
    Array.from(editor?.querySelectorAll('.dshet-footer button') ?? []).map(
      (button) => (button.textContent ?? '').trim(),
    )

  /** 造一个"它在场"的环境：行里有它的笔，还有一个它的编辑器（页脚 [取消][保存]）。 */
  const withForeignEditor = (): void => {
    const row = userRows()[0]
    const foreign = document.createElement('button')
    foreign.type = 'button'
    foreign.className = 'dshet-action dshet-row-action'
    foreign.setAttribute('aria-label', '编辑这条消息')
    row.append(foreign)

    const layer = document.createElement('div')
    layer.className = 'dshet-layer'
    const editor = document.createElement('div')
    editor.className = 'dshet-editor'
    editor.setAttribute('data-dshet-editor', '1')
    const rect = row.getBoundingClientRect()
    editor.style.left = `${String(Math.round(rect.left))}px`
    editor.style.top = `${String(Math.round(rect.bottom + 6))}px`
    editor.style.width = `${String(Math.round(rect.width))}px`
    editor.innerHTML = '<textarea></textarea><div class="dshet-footer"></div>'
    const footer = editor.querySelector('.dshet-footer')
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'dshet-btn'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => {
      layer.remove()
    })
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'dshet-btn dshet-btn-primary'
    save.textContent = '保存'
    footer?.append(cancel, save)
    layer.append(editor)
    document.body.append(layer)
  }

  it('把控件注入到每一个用户行里', () => {
    mount()
    for (const row of userRows()) expect(pagerIn(row)).not.toBeNull()
    // 单版本时**不摆** 1/1（那是噪声，还会把动作区撑长），只留两个图标动作；
    // 文字都在 title / aria-label 里，可读性不丢。
    expect(pagerIn(userRows()[0])?.querySelector('[title="上一条输入版本"]')).toBeNull()
    expect(pagerIn(userRows()[0])?.querySelector('[title="上一条回复版本"]')).toBeNull()
    expect(pagerIn(userRows()[0])?.querySelector('button[aria-label="编辑"]')).not.toBeNull()
    // 圆弧箭头（行内重跑）已按要求去掉：它只做本地版本分页，容易和"真的重跑"混淆，
    // 真正会动会话的是编辑器里的【分页重跑】。
    expect(pagerIn(userRows()[0])?.querySelector('button[aria-label="重跑"]')).toBeNull()
  })

  it('编辑开新输入版本：新输入没有回复，后缀行消失；翻回去它们回来', () => {
    const pager = mount()

    editViaTop(userRows()[0], '甲问改')
    pager.refresh()

    // 新输入版本成为当前 → 输入 2/2，且第二轮整条隐藏
    expect(countInTop(userRows()[0], '输入')).toBe('2/2')
    expect(visible(userRows()[1])).toBe(false)
    expect(visible(assistantRows()[1])).toBe(false)

    // 翻回上一条输入版本 → 旧后缀（乙问 + 它的回复）重新显示
    buttonByTitle(userRows()[0], '上一条输入版本')?.click()
    pager.refresh()
    expect(countInTop(userRows()[0], '输入')).toBe('1/2')
    expect(visible(userRows()[1])).toBe(true)
    expect(visible(assistantRows()[1])).toBe(true)
  })

  it('分页重跑仍会给这条回复开新版本：后缀行消失；翻回旧版本它们回来', () => {
    // 行内的圆弧箭头去掉了，但"开新版本 + 后缀隐藏"这件事没丢 —— 它现在只从
    // 编辑器里的【分页重跑】发生（没接宿主通道时退回纯本地分页）。
    const pager = mount()

    editViaTop(userRows()[0], '甲问改')
    pager.refresh()

    // 新输入版本成为当前：输入链 2 个，且第二轮整条隐藏。
    // 新输入只有 1 个回复版本，所以**不该**出现回复翻页器（单版本不占位）。
    expect(countIn(userRows()[0], '输入')).toBe('2/2')
    expect(countIn(userRows()[0], '回复')).toBeNull()
    expect(visible(userRows()[1])).toBe(false)

    // 翻回旧输入版本 → 后缀行回来
    buttonByTitle(userRows()[0], '上一条输入版本')?.click()
    pager.refresh()
    expect(countIn(userRows()[0], '输入')).toBe('1/2')
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
    const pager = mount()
    editViaTop(userRows()[0], '甲问改')
    pager.refresh()
    pager.dispose()
    handle = null

    chatDom()
    const again = mount()
    again.refresh()
    expect(countInTop(userRows()[0], '输入')).toBe('2/2')
    expect(visible(userRows()[1])).toBe(false)
  })

  it('只装我：页脚是 [取消][分页重跑]，取消不动模型', () => {
    const pager = mount()
    buttonByTitle(userRows()[0], '以这条为起点开一个新输入版本')?.click()

    const editor = document.querySelector<HTMLElement>('.dshet-editor')
    expect(editor).not.toBeNull()
    expect(editor?.hasAttribute('data-rewind-pro-editor')).toBe(true)
    expect(footerLabels(editor)).toEqual(['取消', '分页重跑'])

    // 取消：关掉编辑器，模型一个版本都不许多
    const cancel = Array.from(editor?.querySelectorAll('button') ?? []).find(
      (candidate) => (candidate.textContent ?? '').trim() === '取消',
    )
    ;(cancel as HTMLButtonElement | undefined)?.click()
    expect(document.querySelector('.dshet-editor')).toBeNull()
    pager.refresh()
    expect(countInTop(userRows()[0], '输入')).toBeNull()
  })

  it('两个都装：一支笔；我的按钮插在它的保存左侧', async () => {
    const pager = mount()
    withForeignEditor()
    pager.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 一行动作只显示一支笔：我的那支让位，它那支在场
    const mine = userRows()[0].querySelector<HTMLElement>('button[aria-label="编辑"]')
    expect(mine?.style.display).toBe('none')
    const visiblePencils = Array.from(
      userRows()[0].querySelectorAll<HTMLElement>('button[aria-label="编辑"], button[aria-label="编辑这条消息"]'),
    ).filter((button) => button.style.display !== 'none')
    expect(visiblePencils).toHaveLength(1)

    // 它加载时我绝不打开自己的编辑器：它的 clearEditor() 按类名全页删除
    expect(document.querySelector('[data-rewind-pro-editor]')).toBeNull()
    ;(mine as HTMLButtonElement | null)?.click()
    expect(document.querySelector('[data-rewind-pro-editor]')).toBeNull()

    // 它的页脚变成 [取消][分页重跑][保存]
    const foreign = document.querySelector<HTMLElement>('.dshet-editor')
    expect(footerLabels(foreign)).toEqual(['取消', '分页重跑', '保存'])

    // 我的按钮干我的事：开新输入版本；它的编辑器用"它的取消"关闭
    const bridge = foreign?.querySelector<HTMLButtonElement>('.dsh-rewind-pro-bridge-action')
    const area = foreign?.querySelector('textarea')
    if (area) area.value = '甲问改'
    bridge?.click()
    // 关闭它的编辑器是**异步**的：必须等宿主结果回来才决定"关"还是"把原因留下"
    await new Promise((resolve) => setTimeout(resolve, 0))
    pager.refresh()

    expect(countInTop(userRows()[0], '输入')).toBe('2/2')
    expect(document.querySelector('.dshet-editor')).toBeNull()
  })

  it('我不在场时不动它的页脚（并对已插入的按钮做清理）', async () => {
    const pager = mount()
    withForeignEditor()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 我在场 → 插进去了；dispose 必须把它拔掉
    expect(document.querySelector('.dsh-rewind-pro-bridge-action')).not.toBeNull()
    pager.dispose()
    handle = null
    expect(document.querySelector('.dsh-rewind-pro-bridge-action')).toBeNull()

    // 之后再出现的编辑器（"只装它"的情形）我也不该碰
    document.querySelector('.dshet-layer')?.remove()
    withForeignEditor()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const foreign = document.querySelector<HTMLElement>('.dshet-editor')
    expect(footerLabels(foreign)).toEqual(['取消', '保存'])
  })

  it('dispose 后控件被移除', () => {
    const pager = mount()
    pager.dispose()
    handle = null
    expect(document.querySelector('.dsh-rewind-pro-pager')).toBeNull()
  })
})

// 真机上踩到的 bug：一条消息在 DOM 里是**嵌套的两层**（外层 flow div 带
// data-chat-flow-key + 内层 input-message div 带 data-chat-node-key）。版本树
// 按 outermost 只绑最外层，而 dsh-edit-turn 把编辑框锚在它自己那一层 ——
// 桥接的几何反解于是落在另一层上，按元素身份查版本树必然查不到，报出来的是
// 一句和真相无关的"先翻一次页再试"。
describe('桥接：它的编辑框锚在嵌套的另一层', () => {
  let handle: BranchPagerHandle | null = null
  let storage = fakeStorage()

  /** 一条消息 = 外层 flow div + 内层 input-message div（真机的形状）。 */
  function nestedTurn(flowKey: string, nodeKey: string, text: string): HTMLElement {
    const outer = document.createElement('div')
    outer.setAttribute('data-chat-flow-key', flowKey)
    const inner = document.createElement('div')
    inner.setAttribute('data-chat-node-key', nodeKey)
    const bubble = document.createElement('span')
    bubble.setAttribute('data-message-text', text)
    bubble.textContent = text
    inner.append(bubble)
    outer.append(inner)
    return outer
  }

  /** happy-dom 的 rect 全是 0，几何反解会退化成长文档序：必须按元素各自钉一个。 */
  function rectOf(element: HTMLElement, left: number, top: number, width: number, height: number): void {
    element.getBoundingClientRect = () =>
      ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect
  }

  const readText = (row: HTMLElement): string =>
    row.querySelector('[data-message-text]')?.textContent?.trim() ?? ''

  const mountPager = (extra: Partial<BranchPagerOptions>): BranchPagerHandle => {
    handle = mountBranchPager({
      sessionId: () => 'session-nested',
      doc: document,
      storage,
      readText,
      askText: () => null,
      ...extra,
    })
    return handle
  }

  /** 它的编辑器：锚在 anchor 那一层下面（定位规则见 placeUnderRow）。 */
  function foreignEditorUnder(anchor: HTMLElement, text: string): HTMLElement {
    const layer = document.createElement('div')
    layer.className = 'dshet-layer'
    const editor = document.createElement('div')
    editor.className = 'dshet-editor'
    editor.setAttribute('data-dshet-editor', '1')
    const rect = anchor.getBoundingClientRect()
    editor.style.left = `${String(Math.round(rect.left))}px`
    editor.style.top = `${String(Math.round(rect.bottom + 6))}px`
    editor.style.width = `${String(Math.round(rect.width))}px`
    const area = document.createElement('textarea')
    area.value = text
    const footer = document.createElement('div')
    footer.className = 'dshet-footer'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'dshet-btn'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => {
      layer.remove()
    })
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'dshet-btn dshet-btn-primary'
    save.textContent = '保存'
    footer.append(cancel, save)
    editor.append(area, footer)
    layer.append(editor)
    document.body.append(layer)
    return editor
  }

  const bridgeButton = (editor: HTMLElement): HTMLButtonElement | null =>
    editor.querySelector<HTMLButtonElement>('.dsh-rewind-pro-bridge-action')

  const errorText = (): string => document.querySelector('.dshet-error')?.textContent?.trim() ?? ''

  const innerOf = (outer: HTMLElement): HTMLElement => outer.querySelector<HTMLElement>('[data-chat-node-key]') ?? outer

  beforeEach(() => {
    handle?.dispose()
    handle = null
    storage = fakeStorage()
    const first = nestedTurn('flow-1:input-message-a', '1:input-message-a', '甲问')
    const second = nestedTurn('flow-2:input-message-b', '2:input-message-b', '乙问')
    rectOf(first, 0, 100, 500, 80)
    rectOf(innerOf(first), 320, 110, 160, 60)
    rectOf(second, 0, 200, 500, 80)
    rectOf(innerOf(second), 320, 210, 160, 60)
    document.body.innerHTML = ''
    document.body.append(first, second)
  })

  afterEach(() => {
    handle?.dispose()
    handle = null
  })

  it('反解落在内层：照样认得出它是哪一轮（并按最外层那一行去定位 seq）', async () => {
    const rows = Array.from(document.body.querySelectorAll<HTMLElement>('[data-chat-flow-key]'))
    const outerA = rows[0]
    const innerA = innerOf(outerA)
    const located: HTMLElement[] = []
    const calls: { seq: number; text: string }[] = []

    mountPager({
      seqOfRow: (row) => {
        located.push(row)
        return 7
      },
      applyBranch: async (input) => {
        calls.push(input)
        return { ok: true }
      },
    })

    // 它的编辑框锚在**内层**（外层宽 500、内层宽 160，几何上只可能命中内层）
    const editor = foreignEditorUnder(innerA, '甲问改')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridgeButton(editor)).not.toBeNull()

    bridgeButton(editor)?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 版本树认的是最外层那一行：seq 也必须按它去问（否则锚点身份对不上）
    expect(located).toEqual([outerA])
    expect(calls).toEqual([{ seq: 7, text: '甲问改' }])
    expect(errorText()).toBe('')
    expect(document.querySelector('.dshet-editor')).toBeNull()
    expect(
      outerA
        .querySelector('.dsh-rewind-pro-pager-stepper[title^="输入版本"] .dsh-rewind-pro-pager-count')
        ?.textContent?.trim(),
    ).toBe('2/2')
  })

  it('反解落在外层、而版本树绑的是另一层时也认得出（两个方向都要）', async () => {
    const rows = Array.from(document.body.querySelectorAll<HTMLElement>('[data-chat-flow-key]'))
    const outerA = rows[0]
    const calls: { seq: number; text: string }[] = []
    mountPager({
      seqOfRow: () => 9,
      applyBranch: async (input) => {
        calls.push(input)
        return { ok: true }
      },
    })

    // 同一个元素、同一套锚点规则，只是编辑框挂在外层：结论必须一样
    const editor = foreignEditorUnder(outerA, '甲问改')
    await new Promise((resolve) => setTimeout(resolve, 0))
    bridgeButton(editor)?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toEqual([{ seq: 9, text: '甲问改' }])
    expect(errorText()).toBe('')
  })

  it('真的不在版本树里的行（更早的历史）：说清原因，且一个版本都不动', async () => {
    const pager = mountPager({ seqOfRow: () => 7, applyBranch: async () => ({ ok: true }) })

    // "加载更早"插到顶部的行：版本树刻意不认领它
    const earlier = nestedTurn('flow-0:input-message-z', '0:input-message-z', '更早')
    rectOf(earlier, 0, 0, 500, 80)
    rectOf(innerOf(earlier), 320, 10, 160, 60)
    document.body.insertBefore(earlier, document.body.firstChild)
    pager.refresh()

    const editor = foreignEditorUnder(innerOf(earlier), '更早改')
    await new Promise((resolve) => setTimeout(resolve, 0))
    bridgeButton(editor)?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(errorText()).toContain('不在')
    expect(document.querySelector('.dshet-editor')).not.toBeNull()
    // 没有任何一轮被改动
    for (const outer of Array.from(document.body.querySelectorAll<HTMLElement>('[data-chat-flow-key]'))) {
      expect(
        outer
          .querySelector('.dsh-rewind-pro-pager-stepper[title^="输入版本"] .dsh-rewind-pro-pager-count')
          ?.textContent?.trim() ?? '1/1',
      ).toBe('1/1')
    }
  })
})

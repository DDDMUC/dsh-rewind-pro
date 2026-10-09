// 版本树翻页器：把「输入版本链 × 回复版本链」的翻页控件插进每一个用户消息行。
//
// 可见效果靠**行可见性**实现：当前分支上的行显示，不在分支上的后缀行隐藏。
// 翻回旧版本时路径重新变长，那些行又回来——这就是原项目"后缀整条跟着选中版本走"
// 的手感，而且不需要宿主配合（宿主只负责把消息渲染出来）。
//
// 模型来自 src/core/branch.ts（纯函数、不可变）。行与轮的对应关系按**顺序**建立：
// 第 i 个用户行 = 当前分支上第 i 轮；多出来的行就是不在分支上的后缀。这样切换版本
// 只改路径长度，DOM 一行都不用重建。

import {
  appendTurn,
  branchPath,
  commitUserEdit,
  deserializeConversation,
  emptyConversation,
  isOnPath,
  rerunReply,
  serializeConversation,
  setReplyText,
  switchInput,
  switchReply,
  type Conversation,
  type Turn,
} from '../core/branch.js'
import { bridgeForeignEditor, hasForeignEditAction, hasForeignPlugin, openOwnEditor } from './inline-edit.js'

const PAGER_CLASS = 'dsh-rewind-pro-pager'
const ACTION_HOST_MARKER = 'dshet-action-host'

// 用户消息在真实 DOM 里的稳定标识是 node/flow key 里的 `input-message`
// （实测：<section data-turn-trigger="true"> + <div data-chat-node-key="13:input-message<uuid>">），
// **不是** data-chat-flow-kind="user" —— 本版宿主的 kind 只有
// assistant-step / tool-call / turn-process / turn-tail / turn-trigger / context。
// 旧写法留在后面兜底，别的构建可能不同。
export const DEFAULT_USER_SELECTORS = [
  // 只留被实测证实的两个：一条消息在 DOM 里是"外层 flow div + 内层 section"，
  // 而 data-turn-trigger / flow-kind="turn-trigger" 还会命中**另一个兄弟元素**，
  // 结果同一条消息被算成两轮、翻页器注入两份（实测 PAGERS=10 / 5 条消息）。
  '[data-chat-flow-key*="input-message"]',
  '[data-chat-node-key*="input-message"]',
  '[data-chat-flow-kind="user"]',
  '[data-message-role="user"]',
  '[data-role="user"]',
  '.dsw-message-user',
]
const DEFAULT_ASSISTANT_SELECTORS = ['[data-chat-flow-kind="assistant-step"]', '[data-message-role="assistant"]', '[data-role="assistant"]']

export interface BranchPagerOptions {
  /** 当前会话 id：模型按会话分开存在 localStorage 里。 */
  sessionId: () => string
  selectors?: string[]
  assistantSelectors?: string[]
  doc?: Document
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** 取一行里真正的用户文本（默认取整行文本，去掉我们注入的控件文本）。 */
  readText?: (row: HTMLElement) => string
  /** 编辑时向用户要新文本；默认用 prompt，测试里可注入。 */
  askText?: (current: string) => string | null
  /** 把一行定位到会话日志里的 seq；拿不准就返回 null（猜 seq 会改错消息）。 */
  seqOfRow?: (row: HTMLElement) => number | null
  /** 真的改提示词 + 真的重跑（走宿主路由）。不提供就退回纯本地分页。 */
  applyBranch?: (input: { seq: number; text: string }) => Promise<{ ok: boolean; reason?: string }>
}

export interface BranchPagerHandle {
  /** 重新扫描 DOM、重建模型差量、重画翻页器与可见性。 */
  refresh: () => void
  dispose: () => void
}

interface Rows {
  users: HTMLElement[]
  /** 每个用户行后面跟着的助手行（按用户行下标分组）。 */
  assistants: HTMLElement[][]
  order: HTMLElement[]
}

const textOf = (element: HTMLElement, selector: string): string => {
  const clone = element.cloneNode(true) as HTMLElement
  for (const injected of Array.from(clone.querySelectorAll(`.${PAGER_CLASS}`))) injected.remove()
  return (clone.querySelector(selector) ?? clone).textContent?.trim() ?? ''
}

/** 一行里最后一个"只有图标"的按钮，就是我们插控件的位置（与 ↶ 按钮同一套技法）。 */
function actionHost(row: HTMLElement): HTMLElement {
  // 排除我们自己的翻页器：它也带着 ACTION_HOST_MARKER（为了让别的插件的行处理
  // 放它一马），如果把它当成宿主，下一次刷新就会在它内部再插一个 —— 实测表现
  // 就是同一条消息里出现两份 "输入 1/1"。
  const existing = row.querySelector<HTMLElement>(`.${ACTION_HOST_MARKER}:not(.${PAGER_CLASS})`)
  if (existing) return existing
  const icons = Array.from(row.querySelectorAll('button')).filter(
    (button) => button.textContent !== null && button.textContent.trim().length === 0,
  )
  const anchor = icons[icons.length - 1]
  if (anchor?.parentElement) return anchor.parentElement
  return row
}

/**
 * 只保留**最外层**的匹配元素。
 *
 * 一条消息在真实 DOM 里是嵌套的几层（外层 flow div 带 data-chat-node-key，
 * 里面还有 <section data-turn-trigger>），多个选择器会同时命中它们 —— 那样
 * 同一条消息会被当成好几轮，翻页器也会重复注入。按"谁包含谁"去重即可。
 */
function outermost(elements: HTMLElement[]): HTMLElement[] {
  return elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)))
}

function collect(root: ParentNode, userSelectors: string[], assistantSelectors: string[]): Rows {
  const users = outermost(Array.from(root.querySelectorAll<HTMLElement>(userSelectors.join(','))))
  const assistantsAll = outermost(Array.from(root.querySelectorAll<HTMLElement>(assistantSelectors.join(','))))
  const order = Array.from(root.querySelectorAll<HTMLElement>([...userSelectors, ...assistantSelectors].join(',')))
  const assistants: HTMLElement[][] = users.map(() => [])
  let current = -1
  for (const node of order) {
    const index = users.indexOf(node)
    if (index >= 0) {
      current = index
      continue
    }
    if (current >= 0) assistants[current].push(node)
  }
  return { users, assistants, order }
}

/**
 * 主干：对话区渲染出来的那条**完整线性历史** —— root → 第一个输入 → 第一个回复 →
 * next ……（也就是最初那条链，分支都挂在它旁边）。
 *
 * 重新挂载时靠它把 DOM 里已有的行**认领**回模型里已有的轮：没有这一步，
 * 恢复出来的模型就只能看着行发呆（行绑定不上 → 翻页器不出现）。
 */
function trunkTurns(conversation: Conversation | null): Turn[] {
  const turns: Turn[] = []
  const seen = new Set<string>()
  let turn = conversation?.root ?? null
  while (turn) {
    if (seen.has(turn.id)) break
    seen.add(turn.id)
    turns.push(turn)
    const input = turn.inputs[0]
    turn = input?.replies[0]?.next ?? null
  }
  return turns
}

export function mountBranchPager(options: BranchPagerOptions): BranchPagerHandle {
  const doc = options.doc ?? document
  const storage = options.storage === undefined ? safeStorage() : options.storage
  const userSelectors = options.selectors ?? DEFAULT_USER_SELECTORS
  const assistantSelectors = options.assistantSelectors ?? DEFAULT_ASSISTANT_SELECTORS
  // 正文取法有两层：先找专用的文本节点（准确），找不到就退回整行文本并去掉
  // 我们注入的控件。真实 DOM 里承载文本的 class 名没有公开约定，兜底能保证
  // "编辑"至少带着原话打开，而不是空白。
  const readText =
    options.readText ??
    ((row: HTMLElement) => {
      const dedicated = textOf(row, '.dsh-rewind-pro-text, [data-message-text], .dsw-message-text')
      return dedicated.length > 0 ? dedicated : textOf(row, '*')
    })
  const askText = options.askText ?? ((current: string) => doc.defaultView?.prompt?.('编辑这条消息', current) ?? null)

  let model: Conversation = emptyConversation()
  let frame = 0
  let disposed = false

  /**
   * 行 → 轮 的绑定按**元素身份**做，不按下标。
   *
   * 下标绑定在真实界面里必然错位：对话区是渐进渲染的（"加载更早"把更早的消息
   * 插到顶部、流式回复让行数在两次 refresh 之间变化）。按下标的后果我实测过 ——
   * 后渲染出来的行没进模型，于是被判成"不在当前分支上"而**被隐藏**，也就是
   * 把用户的消息藏起来。身份绑定天然免疫这些。
   */
  let bound: { row: HTMLElement; turnId: string; assistants: HTMLElement[] }[] = []
  /** 已经加载过哪个会话的模型。**每个会话只加载一次**。 */
  let loadedKey: string | null = null
  /**
   * 刚从存储恢复出模型：这一轮允许用"文本一致"把 DOM 行**认领**回已有的轮。
   *
   * 只允许一次、且必须文本对得上：认领是唯一可能张冠李戴的动作（把某一行认到
   * 别一轮上，补回复时就凭空多出一个版本）。认不上就不绑，那一行保持原样
   * （可见、无控件）—— 我们绝不去动自己没有把握的行。
   */
  let claiming = false

  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()

  /**
   * 文本是否**指向同一条消息**。
   *
   * 不能要求完全相等：编辑只改模型（DOM 里仍是原话），所以模型里的 "甲问改"
   * 与 DOM 里的 "甲问" 必须算同一轮。前缀关系足够，又不会把两条不同的消息认混。
   */
  const sameMessage = (a: string, b: string): boolean => {
    const left = normalize(a)
    const right = normalize(b)
    if (left.length < 2 || right.length < 2) return false
    return left === right || left.startsWith(right) || right.startsWith(left)
  }

  const key = (): string => `dsh-rewind-pro.branch.${options.sessionId()}`

  /**
   * 只在**切换会话**时从存储读回模型。
   *
   * 原来每次 refresh 都重读一遍，而刚绑定出来的模型并没有立刻落盘 —— 于是内存里
   * 的模型每一轮都被清空，绑定过的行随之被判成"不在分支上"而隐藏。真机上这就是
   * "藏消息 + 冒出没人创建过的版本"。内存里的模型才是当前真相，存储只是它的持久化。
   */
  const load = (): void => {
    const current = key()
    if (loadedKey === current) return
    loadedKey = current
    // 换了模型就必须丢掉旧绑定：那些 turnId 属于上一个模型，留着会让行
    // "不在分支上"而被隐藏，重新绑定还会造出重复版本。
    // （会话 id 确实会中途变化：初始可能是 unknown，真实 id 稍后才到。）
    bound = []
    try {
      const raw = storage?.getItem(current) ?? null
      model = raw ? deserializeConversation(JSON.parse(raw)) : emptyConversation()
    } catch {
      model = emptyConversation()
    }
    claiming = model.root !== null
  }

  const save = (): void => {
    try {
      storage?.setItem(key(), JSON.stringify(serializeConversation(model)))
    } catch {
      /* 存不下也不影响本次使用 */
    }
  }

  const boundFor = (row: HTMLElement): string | undefined =>
    bound.find((entry) => entry.row === row)?.turnId

  const assistantText = (rows: Rows, index: number): string =>
    rows.assistants[index]?.map((row) => readText(row)).join('\n').trim() ?? ''

  /**
   * 把新出现的用户行接进模型（模型只增不改，旧枝永不丢）。
   *
   * 只吸收**紧接当前分支末尾**的行：它前面那一行必须已经绑定过（或模型还空）。
   * 出现在更早位置的行（"加载更早"）不进模型，因此也不受分支可见性控制 ——
   * 我们绝不去隐藏自己没有把握的行。
   */
  const bindRows = (rows: Rows): void => {
    const trunk = trunkTurns(model)
    rows.users.forEach((row, index) => {
      if (boundFor(row)) return
      // 1) 认领：只在"刚从存储恢复"这一轮，且文本对得上（见 claiming 的注释）
      const claim = claiming ? trunk[index] : undefined
      if (claim && !bound.some((entry) => entry.turnId === claim.id)) {
        const claimText = claim.inputs[claim.selectedInput]?.text ?? ''
        if (sameMessage(claimText, readText(row))) {
          bound.push({ row, turnId: claim.id, assistants: rows.assistants[index] ?? [] })
          return
        }
      }
      // 2) 追加：只在"接着分支末尾"时把行当成新的一轮
      const previousRow = index > 0 ? rows.users[index - 1] : null
      const previousTurnId = previousRow ? boundFor(previousRow) : undefined
      const nodes = branchPath(model)
      const tailTurnId = nodes[nodes.length - 1]?.turn.id
      if (previousRow && previousTurnId === undefined) return
      if (previousRow && previousTurnId !== tailTurnId) return
      if (!previousRow && nodes.length > 0) return

      const previous = nodes[nodes.length - 1]
      if (previous && !previous.reply) {
        model = rerunReply(model, previous.turn.id, assistantText(rows, index - 1))
      }
      model = appendTurn(model, readText(row))
      const created = branchPath(model)
      const turnId = created[created.length - 1]?.turn.id
      if (!turnId) return
      bound.push({ row, turnId, assistants: rows.assistants[index] ?? [] })
    })

    // 认领只做一轮：之后新出现的行只能"接到末尾"，认不上就不管它
    claiming = false

    // 回复正文随 DOM 更新（流式落定后把最新文本写进当前回复版本）
    for (const entry of bound) {
      const text = entry.assistants.map((row) => readText(row)).join('\n').trim()
      const node = branchPath(model).find((candidate) => candidate.turn.id === entry.turnId)
      if (!text || !node?.reply || node.reply.text === text) continue
      const updated = setReplyText(model, entry.turnId, text)
      if (updated !== model) model = updated
    }
  }

  /** 只动**绑定过**的行：绑定不了的（更早的历史、结构不认识的）一律不碰。 */
  const applyVisibility = (): void => {
    for (const entry of bound) {
      if (!entry.row.isConnected) continue
      const onPath = isOnPath(model, entry.turnId)
      entry.row.style.display = onPath ? '' : 'none'
      for (const assistant of entry.assistants) {
        if (assistant.isConnected) assistant.style.display = onPath ? '' : 'none'
      }
    }
  }

  const renderControls = (): void => {
    for (const entry of bound) {
      if (!entry.row.isConnected) continue
      const row = entry.row
      const node = branchPath(model).find((candidate) => candidate.turn.id === entry.turnId)
      const host = actionHost(row)
      // 在整个行里找（而不是 :scope > ），宿主位置随刷新漂移时也不会重复注入
      let pager = row.querySelector<HTMLElement>(`.${PAGER_CLASS}`)
      if (!pager) {
        pager = doc.createElement('span')
        pager.className = `${PAGER_CLASS} ${ACTION_HOST_MARKER}`
        host.append(pager)
      }
      pager.textContent = ''
      if (!node) {
        // 不在当前分支上：这一行本身也被隐藏了，控件跟着收起
        pager.style.display = 'none'
        continue
      }
      pager.style.display = ''
      const turnId = node.turn.id
      const inputStepper = stepper(doc, '输入', node.turn.selectedInput, node.turn.inputs.length, (next) => {
        model = switchInput(model, turnId, next)
        save()
        refresh()
      })
      const replyStepper = stepper(doc, '回复', node.input.selectedReply, node.input.replies.length, (next) => {
        model = switchReply(model, turnId, next)
        save()
        refresh()
      })

      // 单版本时 stepper 返回 null（那一行本来没什么可翻的），只留两个图标动作。
      if (inputStepper) pager.append(inputStepper)
      if (inputStepper && replyStepper) {
        const separator = doc.createElement('span')
        separator.className = `${PAGER_CLASS}-sep`
        pager.append(separator)
      }
      if (replyStepper) pager.append(replyStepper)

      const foreignEdit = hasForeignEditAction(row)
      const editButton = action(doc, () => {
        // 它的插件在场时**绝不开我自己的编辑器**：它的 clearEditor() 会按类名把
        // 页面上任何 .dshet-editor 删掉（源码实测如此），我的编辑器会被无声吞掉。
        // 那种情况下我的功能走它的编辑器页脚（见 bridgeForeignEditor）。
        if (hasForeignPlugin(doc)) return
        openOwnEditor({
          doc,
          row,
          text: node.input.text,
          submitLabel: '分页重跑',
          cancelLabel: '取消',
          onSubmit: (text) => realBranch(row, node.turn.id, text),
        })
      })
      // 它那支笔在场时我让位：一行动作只留一支笔，我的功能改由它的编辑器页脚承载。
      if (foreignEdit) editButton.style.display = 'none'

      // 行里只留这一支笔（圆弧箭头已按要求去掉）
      pager.append(editButton)
    }
  }

  /**
   * 选择器与本版 DOM 不匹配时**必须看得见**。
   *
   * 之前这类问题表现为"界面上什么都没有"，而页面上又没有任何提示，只能靠
   * 一点一点猜 —— 这条自检把它变成一眼可见的红字。
   */
  const updateWarn = (rows: Rows): void => {
    const existing = doc.querySelector('[data-rewind-pro-warn]')
    const hasFlow = doc.querySelectorAll('[data-chat-flow-key]').length > 0
    if (rows.users.length > 0 || !hasFlow) {
      existing?.remove()
      return
    }
    if (existing) return
    const warn = doc.createElement('div')
    warn.setAttribute('data-rewind-pro-warn', '1')
    warn.textContent = '版本树：未匹配到消息行（选择器与本版 DSH 不匹配）'
    warn.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;padding:6px 10px;border-radius:6px;font-size:12px;background:rgba(200,40,40,.92);color:#fff'
    doc.body.append(warn)
  }

  const refresh = (): void => {
    if (disposed) return
    const rows = collect(doc.body, userSelectors, assistantSelectors)
    updateWarn(rows)
    if (rows.users.length === 0) return
    load()
    // 已经在 DOM 里被移除的行不再管它
    bound = bound.filter((entry) => entry.row.isConnected)
    bindRows(rows)
    renderControls()
    applyVisibility()
  }

  const schedule = (): void => {
    if (disposed || frame) return
    frame = (doc.defaultView ?? window).requestAnimationFrame(() => {
      frame = 0
      refresh()
    })
  }

  /**
   * 我的主行动作「分页重跑」：以**编辑后的文本**开一个新输入版本，并给它一个新
   * 回复版本（新枝在这里长出来，旧后缀原样保留）。
   *
   * 它同时被两个入口调用：我自己编辑器里的主按钮，以及**它的**编辑器页脚里
   * 我插进去的那个按钮 —— 两条路必须是同一件事，否则"两个都装"时行为会不一致。
   */
  const branchFrom = (row: HTMLElement, text: string): void => {
    const turnId = boundFor(row)
    if (!turnId) return
    model = commitUserEdit(model, turnId, text)
    model = rerunReply(model, turnId, '')
    save()
    refresh()
  }

  /**
   * 真的动手：先让宿主改提示词并重跑，**成功之后**才更新我自己的模型。
   *
   * 三条纪律，都是为了避免"看起来成功了其实什么都没发生"：
   *   * 定位不到 seq 就拒绝（猜 seq 会把遮蔽写到别的消息上，那是破坏性的）；
   *   * 宿主失败就把原因原样报回去，本地模型一个版本都不许动；
   *   * 没接宿主通道时才退回纯本地分页（老行为）。
   */
  const realBranch = async (
    row: HTMLElement,
    turnId: string,
    text: string,
  ): Promise<{ ok: boolean; reason?: string }> => {
    const branch = options.applyBranch
    const seqOf = options.seqOfRow
    if (!branch || !seqOf) {
      branchFrom(row, text)
      return { ok: true }
    }
    const seq = seqOf(row)
    if (seq === null) {
      return { ok: false, reason: '定位不到这条消息在会话日志里的位置，已取消（没有做任何改动）。' }
    }
    const result = await branch({ seq, text })
    if (!result.ok) return { ok: false, reason: result.reason ?? '宿主拒绝了这次分页重跑。' }
    model = commitUserEdit(model, turnId, text)
    save()
    refresh()
    return { ok: true }
  }

  // 它（dsh-edit-turn）在场时，我的「分页重跑」接进**它的**编辑器页脚：
  // 一行动作只留一支笔，而功能由它的页脚承载（[取消][分页重跑][保存]）。
  const bridge = bridgeForeignEditor({
    doc,
    label: '分页重跑',
    rowSelectors: userSelectors,
    onAction: (row, text) => {
      const turnId = boundFor(row)
      if (!turnId) return { ok: false, reason: '这一行还没进我的版本树，先翻一次页再试。' }
      return realBranch(row, turnId, text)
    },
  })

  const observer = new MutationObserver(schedule)
  observer.observe(doc.body, { childList: true, subtree: true })
  refresh()

  return {
    refresh,
    dispose() {
      disposed = true
      if (frame) (doc.defaultView ?? window).cancelAnimationFrame(frame)
      observer.disconnect()
      bridge.dispose()
      for (const node of Array.from(doc.querySelectorAll(`.${PAGER_CLASS}`))) node.remove()
    },
  }
}

/** 翻页器；链上只有一个版本时返回 null（调用方据此不占位）。 */
function stepper(
  doc: Document,
  label: string,
  selected: number,
  total: number,
  onPick: (index: number) => void,
): HTMLElement | null {
  const box = doc.createElement('span')
  box.className = `${PAGER_CLASS}-stepper`
  box.title = `${label}版本：当前 ${String(selected + 1)}/${String(total)}`
  // 只有一个版本时不占位置：那一行本来就没什么可翻的，摆个 "1/1" 纯属噪声，
  // 而且会把行里的动作区撑得很长。翻页器只在**真的有多个版本**时现身。
  if (total <= 1) return null
  const before = doc.createElement('button')
  before.type = 'button'
  before.className = `dsh-rewind-pro-btn ${PAGER_CLASS}-btn`
  before.textContent = '‹'
  before.title = `上一条${label}版本`
  before.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onPick((selected - 1 + total) % total)
  })
  const after = doc.createElement('button')
  after.type = 'button'
  after.className = `dsh-rewind-pro-btn ${PAGER_CLASS}-btn`
  after.textContent = '›'
  after.title = `下一条${label}版本`
  after.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onPick((selected + 1) % total)
  })
  const name = doc.createElement('span')
  name.className = `${PAGER_CLASS}-label`
  // 末尾留一个空格：CSS 布局靠 gap，但 textContent 里连在一起就读不通了
  name.textContent = `${label} `
  const caption = doc.createElement('span')
  caption.className = `${PAGER_CLASS}-count`
  caption.textContent = `${String(selected + 1)}/${String(total)}`
  box.append(name, before, caption, after)
  return box
}

/**
 * 行动作：**内联 SVG 图标**，不是文字也不是 Unicode 字形。
 *
 * 两个原因，都是踩过的：
 *   1. 按钮是 18px 见方的图标位，中文塞进去必然被挤成竖排（第一版就是这样）；
 *   2. `✎` / `⟳` 这类字形依赖字体，缺字时渲染成豆腐块 —— SVG 不依赖字体。
 *
 * **笔的路径与 dsh-edit-turn 逐字一致**（同样三条 path、同样 16×16 viewBox、
 * 同样 stroke-width 1.2、同样 round 端点）：用户要求"笔做成和它一样的"，
 * 而"一样"最可靠的做法就是抄它的几何，而不是我自己画一支像的。
 * 抄自 dsh-edit-turn `ICON_PATHS` + `ICON_MARKUP`。
 */
const EDIT_TURN_ICON_PATHS = ['M11.2 2.4l2.4 2.4', 'M3.1 10.5l7.1-7.1 2.4 2.4-7.1 7.1-3.1.7z', 'M2.6 13.6h10.8']
const PENCIL_MARKUP =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  EDIT_TURN_ICON_PATHS.map(
    (d) => `<path d="${d}" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  ).join('') +
  '</svg>'

/**
 * 行里唯一的动作：**笔**（打开编辑器，编辑器里有【分页重跑】）。
 *
 * 原先这里还有一个圆弧箭头（行内"重跑"），已按要求去掉：它只在我自己的版本树里
 * 加一个版本、**不碰会话**，和编辑器里那个"真的会动会话"的【分页重跑】容易混淆。
 */
function action(doc: Document, onPick: () => void): HTMLElement {
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = `dsh-rewind-pro-btn ${PAGER_CLASS}-btn`
  button.innerHTML = PENCIL_MARKUP
  button.title = '以这条为起点开一个新输入版本'
  button.setAttribute('aria-label', '编辑')
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onPick()
  })
  return button
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    const view = typeof window === 'undefined' ? null : window
    const store = view?.localStorage
    return store && typeof store.getItem === 'function' && typeof store.setItem === 'function' ? store : null
  } catch {
    return null
  }
}

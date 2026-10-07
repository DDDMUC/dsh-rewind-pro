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
  rerunReply,
  serializeConversation,
  setReplyText,
  switchInput,
  switchReply,
  type Conversation,
} from '../core/branch.js'

const PAGER_CLASS = 'dsh-rewind-pro-pager'
const ACTION_HOST_MARKER = 'dshet-action-host'

const DEFAULT_USER_SELECTORS = ['[data-chat-flow-kind="user"]', '[data-message-role="user"]', '[data-role="user"]', '.dsw-message-user']
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
  const existing = row.querySelector<HTMLElement>(`.${ACTION_HOST_MARKER}`)
  if (existing) return existing
  const icons = Array.from(row.querySelectorAll('button')).filter(
    (button) => button.textContent !== null && button.textContent.trim().length === 0,
  )
  const anchor = icons[icons.length - 1]
  if (anchor?.parentElement) return anchor.parentElement
  return row
}

function collect(root: ParentNode, userSelectors: string[], assistantSelectors: string[]): Rows {
  const users = Array.from(root.querySelectorAll<HTMLElement>(userSelectors.join(',')))
  const assistantsAll = Array.from(root.querySelectorAll<HTMLElement>(assistantSelectors.join(',')))
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

export function mountBranchPager(options: BranchPagerOptions): BranchPagerHandle {
  const doc = options.doc ?? document
  const storage = options.storage === undefined ? safeStorage() : options.storage
  const userSelectors = options.selectors ?? DEFAULT_USER_SELECTORS
  const assistantSelectors = options.assistantSelectors ?? DEFAULT_ASSISTANT_SELECTORS
  const readText = options.readText ?? ((row: HTMLElement) => textOf(row, '.dsh-rewind-pro-text, [data-message-text], .dsw-message-text'))
  const askText = options.askText ?? ((current: string) => doc.defaultView?.prompt?.('编辑这条消息', current) ?? null)

  let model: Conversation = emptyConversation()
  let frame = 0
  /**
   * 已经当作基线吸收过的用户行数（-1 = 刚加载，尚未与 DOM 对账）。
   *
   * 这是翻页与 DOM 的关键解耦：DOM 里永远躺着**完整**的线性历史，而我们只
   * 隐藏不在分支上的行。若每次 refresh 都按 DOM 重建模型，编辑/重跑刚开出的
   * 新分支会被那些仍然存在的旧行立刻拼回去 —— 后缀就永远藏不住了。
   */
  let absorbed = -1
  let disposed = false

  const key = (): string => `dsh-rewind-pro.branch.${options.sessionId()}`

  const load = (): void => {
    try {
      const raw = storage?.getItem(key()) ?? null
      model = raw ? deserializeConversation(JSON.parse(raw)) : emptyConversation()
      absorbed = -1
    } catch {
      model = emptyConversation()
      absorbed = -1
    }
  }

  const save = (): void => {
    try {
      storage?.setItem(key(), JSON.stringify(serializeConversation(model)))
    } catch {
      /* 存不下也不影响本次使用 */
    }
  }

  /** 把 DOM 里新出现的用户行补进模型（模型只增不改，旧枝永不丢）。 */
  const absorbRows = (rows: Rows): void => {
    for (let index = Math.max(0, absorbed); index < rows.users.length; index++) {
      const nodes = branchPath(model)
      if (index < nodes.length) {
        // 已有这一轮：正文或回复文本变了就更新（不改版本数）
        continue
      }
      const previous = nodes[nodes.length - 1]
      if (previous && !previous.reply) {
        const replyText = rows.assistants[index - 1]?.map((row) => readText(row)).join('\n').trim() ?? ''
        model = rerunReply(model, previous.turn.id, replyText)
      }
      model = appendTurn(model, readText(rows.users[index]))
    }
    // 回复正文按 DOM 补齐（流式落定后这里会把最新文本写进当前回复版本）
    const nodes = branchPath(model)
    for (let index = 0; index < nodes.length; index++) {
      const text = rows.assistants[index]?.map((row) => readText(row)).join('\n').trim() ?? ''
      const node = nodes[index]
      if (!text || !node.reply || node.reply.text === text) continue
      const updated = setReplyText(model, node.turn.id, text)
      if (updated !== model) model = updated
    }
  }

  const applyVisibility = (rows: Rows): void => {
    const visible = branchPath(model).length
    rows.users.forEach((row, index) => {
      const show = index < visible
      row.style.display = show ? '' : 'none'
    })
    rows.assistants.forEach((group, index) => {
      const show = index < visible
      for (const row of group) row.style.display = show ? '' : 'none'
    })
  }

  const renderControls = (rows: Rows): void => {
    const nodes = branchPath(model)
    rows.users.forEach((row, index) => {
      const node = nodes[index]
      const host = actionHost(row)
      let pager = host.querySelector<HTMLElement>(`:scope > .${PAGER_CLASS}`)
      if (!pager) {
        pager = doc.createElement('span')
        pager.className = `${PAGER_CLASS} ${ACTION_HOST_MARKER}`
        host.append(pager)
      }
      pager.textContent = ''
      if (!node) {
        pager.style.display = 'none'
        return
      }
      pager.style.display = ''
      const turnId = node.turn.id

      pager.append(
        stepper(doc, '输入', node.turn.selectedInput, node.turn.inputs.length, (next) => {
          model = switchInput(model, turnId, next)
          save()
          refresh()
        }),
        stepper(doc, '回复', node.input.selectedReply, node.input.replies.length, (next) => {
          model = switchReply(model, turnId, next)
          save()
          refresh()
        }),
        action(doc, '编辑', () => {
          const text = askText(node.input.text)
          if (text === null || text === node.input.text) return
          model = commitUserEdit(model, turnId, text)
          save()
          refresh()
        }),
        action(doc, '重跑', () => {
          model = rerunReply(model, turnId, '')
          save()
          refresh()
        }),
      )
    })
  }

  const refresh = (): void => {
    if (disposed) return
    const rows = collect(doc.body, userSelectors, assistantSelectors)
    if (rows.users.length === 0) return
    load()
    // 刚从存储恢复时，把当前 DOM 里的行全部当作基线（它们属于历史，不是新消息）
    // 模型里还没有任何轮 → DOM 就是基线，全部吸收；
    // 模型非空（刚从 storage 恢复）→ 现有行属于历史，只吸收超出的新行。
    if (absorbed < 0) absorbed = model.root ? rows.users.length : 0
    absorbRows(rows)
    absorbed = rows.users.length
    renderControls(rows)
    applyVisibility(rows)
  }

  const schedule = (): void => {
    if (disposed || frame) return
    frame = (doc.defaultView ?? window).requestAnimationFrame(() => {
      frame = 0
      refresh()
    })
  }

  const observer = new MutationObserver(schedule)
  observer.observe(doc.body, { childList: true, subtree: true })
  refresh()

  return {
    refresh,
    dispose() {
      disposed = true
      if (frame) (doc.defaultView ?? window).cancelAnimationFrame(frame)
      observer.disconnect()
      for (const node of Array.from(doc.querySelectorAll(`.${PAGER_CLASS}`))) node.remove()
    },
  }
}

function stepper(doc: Document, label: string, selected: number, total: number, onPick: (index: number) => void): HTMLElement {
  const box = doc.createElement('span')
  box.className = `${PAGER_CLASS}-stepper`
  box.title = `${label}版本：当前 ${String(selected + 1)}/${String(total)}`
  if (total <= 1) {
    box.textContent = `${label} 1/1`
    box.dataset.empty = 'true'
    return box
  }
  const before = doc.createElement('button')
  before.type = 'button'
  before.className = 'dsh-rewind-pro-btn'
  before.textContent = '‹'
  before.title = `上一条${label}版本`
  before.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onPick((selected - 1 + total) % total)
  })
  const after = doc.createElement('button')
  after.type = 'button'
  after.className = 'dsh-rewind-pro-btn'
  after.textContent = '›'
  after.title = `下一条${label}版本`
  after.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onPick((selected + 1) % total)
  })
  const caption = doc.createElement('span')
  caption.textContent = `${label} ${String(selected + 1)}/${String(total)}`
  box.append(before, caption, after)
  return box
}

function action(doc: Document, label: string, onPick: () => void): HTMLElement {
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'dsh-rewind-pro-btn'
  button.textContent = label
  button.title = label === '编辑' ? '以这条为起点开一个新输入版本' : '给这条回复再生成一个版本（新分支）'
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

// 对话版本树：一轮 = 输入版本链 × 回复版本链。
//
// 结构不是嵌套的，而是靠**每条回复上的 `next` 指针**串成一棵树：
//
//   Turn ── inputs[] ──┬─ input#0 ── replies[] ──┬─ reply#0 ── next ──> Turn(下一轮)
//                      │                          └─ reply#1 ── next ──> …
//                      └─ input#1 ── replies[] ── …
//
// **当前分支 = 从根开始，每轮取「选中输入 → 选中回复 → next」一路走到底。**
//
// 由此得到本模型的三条关键性质：
//   * 编辑用户输入 = **追加一个输入版本**（旧输入连同它后面的整条后缀原样保留）
//   * 重跑 = **给当前输入追加一个回复版本**（新回复的 next 为空，长出新枝）
//   * 翻页只改索引 → 整条后缀跟着换（旧枝一条都不丢，翻回去就全回来）
//
// 生成上下文时**只沿当前分支取**：不在当前路径上的版本不进上下文。
//
// 全部是纯函数、不可变：不读时间、不写盘、不改传入对象（需要的 id 由结构决定，
// 形如 t1 / t1-i2 / t1-i2-r3，同一份输入永远得到同一份 id）。

export const BRANCH_SCHEMA = 2

export interface ReplyVersion {
  id: string
  text: string
  /** 这条回复往下接的那一轮；为空表示这里是当前分支的末端。 */
  next: Turn | null
}

export interface InputVersion {
  id: string
  text: string
  replies: ReplyVersion[]
  /** 选中的回复下标（越界时按 0 处理）。 */
  selectedReply: number
}

export interface Turn {
  id: string
  inputs: InputVersion[]
  /** 选中的输入下标（越界时按 0 处理）。 */
  selectedInput: number
}

export interface Conversation {
  schema: number
  root: Turn | null
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

/** 当前分支上的一轮：选中的输入与（可能还没有的）回复。 */
export interface PathNode {
  turn: Turn
  input: InputVersion
  reply: ReplyVersion | null
}

const clamp = (index: number, length: number): number => (index >= 0 && index < length ? index : 0)

const cloneTurn = (turn: Turn): Turn => ({
  id: turn.id,
  selectedInput: turn.selectedInput,
  inputs: turn.inputs.map((input) => ({
    id: input.id,
    text: input.text,
    selectedReply: input.selectedReply,
    replies: input.replies.map((reply) => ({
      id: reply.id,
      text: reply.text,
      next: reply.next ? cloneTurn(reply.next) : null,
    })),
  })),
})

export const cloneConversation = (conversation: Conversation): Conversation => ({
  schema: conversation.schema,
  root: conversation.root ? cloneTurn(conversation.root) : null,
})

export const emptyConversation = (): Conversation => ({ schema: BRANCH_SCHEMA, root: null })

/**
 * 当前分支：从根开始，每轮取「选中输入 → 选中回复 → next」一路走到底。
 * 某一轮选中的输入还没有回复时，路径就停在这里（那一轮还没有答复）。
 */
export function branchPath(conversation: Conversation): PathNode[] {
  const nodes: PathNode[] = []
  const seen = new Set<string>()
  let turn = conversation.root
  while (turn) {
    if (seen.has(turn.id)) break // 数据坏了也不许死循环
    seen.add(turn.id)
    const input = turn.inputs[clamp(turn.selectedInput, turn.inputs.length)]
    if (!input) break
    const reply = input.replies[clamp(input.selectedReply, input.replies.length)] ?? null
    nodes.push({ turn, input, reply })
    turn = reply?.next ?? null
  }
  return nodes
}

/** 某一轮在当前分支上的序号；不在分支上返回 -1。 */
export function pathIndexOf(conversation: Conversation, turnId: string): number {
  const index = branchPath(conversation).findIndex((node) => node.turn.id === turnId)
  return index
}

export const isOnPath = (conversation: Conversation, turnId: string): boolean =>
  pathIndexOf(conversation, turnId) >= 0

/** 在克隆出来的树上按 turnId 找那一轮（只找当前分支上的，避免改到旧枝）。 */
function locate(turn: Turn | null, turnId: string): Turn | null {
  while (turn) {
    if (turn.id === turnId) return turn
    const input = turn.inputs[clamp(turn.selectedInput, turn.inputs.length)]
    if (!input) return null
    turn = input.replies[clamp(input.selectedReply, input.replies.length)]?.next ?? null
  }
  return null
}

/** 翻页：只改索引，树结构一个节点都不动。 */
export function switchInput(conversation: Conversation, turnId: string, index: number): Conversation {
  const next = cloneConversation(conversation)
  const turn = locate(next.root, turnId)
  if (!turn || index < 0 || index >= turn.inputs.length) return conversation
  turn.selectedInput = index
  return next
}

export function switchReply(conversation: Conversation, turnId: string, index: number): Conversation {
  const next = cloneConversation(conversation)
  const turn = locate(next.root, turnId)
  if (!turn) return conversation
  const input = turn.inputs[clamp(turn.selectedInput, turn.inputs.length)]
  if (!input || index < 0 || index >= input.replies.length) return conversation
  input.selectedReply = index
  return next
}

/** 编辑用户输入 = 追加一个输入版本并选中它；旧输入及其后缀原样保留。 */
export function commitUserEdit(conversation: Conversation, turnId: string, text: string): Conversation {
  const next = cloneConversation(conversation)
  const turn = locate(next.root, turnId)
  if (!turn) return conversation
  turn.inputs.push({ id: `${turn.id}-i${String(turn.inputs.length)}`, text, replies: [], selectedReply: 0 })
  turn.selectedInput = turn.inputs.length - 1
  return next
}

/** 重跑 = 给当前输入追加一个回复版本；新回复的 next 为空（在这里长出新枝）。 */
export function rerunReply(conversation: Conversation, turnId: string, text = ''): Conversation {
  const next = cloneConversation(conversation)
  const turn = locate(next.root, turnId)
  if (!turn) return conversation
  const input = turn.inputs[clamp(turn.selectedInput, turn.inputs.length)]
  if (!input) return conversation
  input.replies.push({ id: `${input.id}-r${String(input.replies.length)}`, text, next: null })
  input.selectedReply = input.replies.length - 1
  return next
}

/** 写入（或覆盖）当前分支末端那条回复的正文——流式回复落定后调用。 */
export function setReplyText(conversation: Conversation, turnId: string, text: string): Conversation {
  const next = cloneConversation(conversation)
  const turn = locate(next.root, turnId)
  if (!turn) return conversation
  const input = turn.inputs[clamp(turn.selectedInput, turn.inputs.length)]
  const reply = input?.replies[clamp(input.selectedReply, input.replies.length)]
  if (!reply) return conversation
  reply.text = text
  return next
}

/**
 * 在当前分支末尾挂新一轮：把末端回复的 `next` 指向它。
 * 末端还没有回复（那一轮没有答复）时无处可挂，返回原对象。
 */
export function appendTurn(conversation: Conversation, inputText: string): Conversation {
  const nodes = branchPath(conversation)
  const last = nodes[nodes.length - 1]
  const id = `t${String(nodes.length + 1)}`
  const created: Turn = { id, selectedInput: 0, inputs: [{ id: `${id}-i0`, text: inputText, replies: [], selectedReply: 0 }] }

  if (!last) {
    const next = cloneConversation(conversation)
    next.root = created
    return next
  }
  if (!last.reply) return conversation

  const next = cloneConversation(conversation)
  const turn = locate(next.root, last.turn.id)
  const input = turn?.inputs[clamp(turn.selectedInput, turn.inputs.length)]
  const reply = input?.replies[clamp(input.selectedReply, input.replies.length)]
  if (!reply) return conversation
  reply.next = created
  return next
}

/**
 * 送给模型的历史：**只沿当前分支**，最近 limit 条。
 * 不在分支上的输入版本与回复版本一律不出现。
 */
export function contextMessages(conversation: Conversation, limit = 20): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const node of branchPath(conversation)) {
    if (node.input.text.length > 0) messages.push({ role: 'user', text: node.input.text })
    if (node.reply && node.reply.text.length > 0) messages.push({ role: 'assistant', text: node.reply.text })
  }
  return limit > 0 ? messages.slice(Math.max(0, messages.length - limit)) : messages
}

/** 每一轮在当前分支上显示的序号（1 起），给「第 n 轮」这类文案用。 */
export function pathLabel(conversation: Conversation, turnId: string): string {
  const index = pathIndexOf(conversation, turnId)
  const nodes = branchPath(conversation)
  if (index < 0) return ''
  const node = nodes[index]
  const inputs = node.turn.inputs.length
  const replies = node.input.replies.length
  return `第 ${String(index + 1)}/${String(nodes.length)} 轮 · 输入 ${String(node.turn.selectedInput + 1)}/${String(inputs)} · 回复 ${
    replies === 0 ? '0/0' : `${String(node.input.selectedReply + 1)}/${String(replies)}`
  }`
}

// ---------------------------------------------------------------- 持久化 / 迁移

export interface SerializedConversation {
  schema: number
  root: unknown
}

/**
 * 读旧数据：把「无版本号的线性列表」包装成单链。
 *
 * 支持三种历史形态，**老数据的后缀一条都不许丢**：
 *   * 已经是本模型（有 inputs/replies）→ 只补齐缺失字段与越界索引
 *   * `turns: [{ input, reply }]` → 串成单链，每个 turn 各一个版本
 *   * `messages: [{ role, text }]` → 相邻的 user/assistant 配成一轮
 */
export function normalizeConversation(raw: unknown): Conversation {
  const record = asRecord(raw)
  if (!record) return emptyConversation()

  const existing = asRecord(record.root)
  if (existing) return { schema: BRANCH_SCHEMA, root: normalizeTurn(existing, 't1') }

  const turns = Array.isArray(record.turns) ? record.turns : null
  if (turns) {
    let root: Turn | null = null
    let tail: ReplyVersion | null = null
    turns.forEach((entry, index) => {
      const item = asRecord(entry) ?? {}
      const id = `t${String(index + 1)}`
      const input: InputVersion = {
        id: `${id}-i0`,
        text: textOf(item.input ?? item.text ?? item.user),
        replies: [],
        selectedReply: 0,
      }
      const replyText = textOf(item.reply ?? item.assistant ?? item.output)
      const turn: Turn = { id, inputs: [input], selectedInput: 0 }
      if (replyText.length > 0 || index < turns.length - 1) {
        const reply: ReplyVersion = { id: `${input.id}-r0`, text: replyText, next: null }
        input.replies.push(reply)
        if (tail) tail.next = turn
        else root = turn
        tail = reply
      } else if (!tail) {
        root = turn
      } else {
        tail.next = turn
      }
    })
    return { schema: BRANCH_SCHEMA, root }
  }

  const messages = Array.isArray(record.messages) ? record.messages : []
  if (messages.length > 0) return normalizeConversation({ turns: pairMessages(messages) })
  return emptyConversation()
}

function pairMessages(messages: unknown[]): { input: string; reply: string }[] {
  const turns: { input: string; reply: string }[] = []
  let pending: string | null = null
  for (const entry of messages) {
    const item = asRecord(entry) ?? {}
    const role = typeof item.role === 'string' ? item.role : 'user'
    const text = textOf(item.text ?? item.content)
    if (role === 'user') {
      if (pending !== null) turns.push({ input: pending, reply: '' })
      pending = text
    } else {
      turns.push({ input: pending ?? '', reply: text })
      pending = null
    }
  }
  if (pending !== null) turns.push({ input: pending, reply: '' })
  return turns
}

/** 读到的树可能缺字段或索引越界：补齐，但绝不删节点。 */
function normalizeTurn(raw: Record<string, unknown>, fallbackId: string): Turn {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : fallbackId
  const rawInputs = Array.isArray(raw.inputs) ? raw.inputs : []
  const inputs: InputVersion[] = rawInputs.map((entry, index) => {
    const item = asRecord(entry) ?? {}
    const inputId = typeof item.id === 'string' && item.id.length > 0 ? item.id : `${id}-i${String(index)}`
    const rawReplies = Array.isArray(item.replies) ? item.replies : []
    const replies: ReplyVersion[] = rawReplies.map((replyEntry, replyIndex) => {
      const reply = asRecord(replyEntry) ?? {}
      const replyId = typeof reply.id === 'string' && reply.id.length > 0 ? reply.id : `${inputId}-r${String(replyIndex)}`
      const nextRaw = asRecord(reply.next)
      return {
        id: replyId,
        text: textOf(reply.text),
        next: nextRaw ? normalizeTurn(nextRaw, `${replyId}-t`) : null,
      }
    })
    return {
      id: inputId,
      text: textOf(item.text),
      replies,
      selectedReply: clamp(typeof item.selectedReply === 'number' ? item.selectedReply : 0, replies.length),
    }
  })
  if (inputs.length === 0) inputs.push({ id: `${id}-i0`, text: '', replies: [], selectedReply: 0 })
  return {
    id,
    inputs,
    selectedInput: clamp(typeof raw.selectedInput === 'number' ? raw.selectedInput : 0, inputs.length),
  }
}

export function serializeConversation(conversation: Conversation): SerializedConversation {
  return { schema: BRANCH_SCHEMA, root: conversation.root ? cloneTurn(conversation.root) : null }
}

export function deserializeConversation(raw: unknown): Conversation {
  return normalizeConversation(raw)
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

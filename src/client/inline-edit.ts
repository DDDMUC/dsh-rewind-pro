// 与 `dsh-edit-turn` 的行内编辑器互操作。
//
// 用户的要求是"像它的、并且互相兼容"，具体到界面就三档：
//
//   只装它   → [取消][保存]
//   只装我   → [取消][分页重跑]
//   两个都装 → 一支笔；[取消][分页重跑][保存]
//
// 做法上**刻意抄它的实现**（类名 `.dshet-layer/.dshet-editor/.dshet-field/.dshet-footer/
// .dshet-btn/.dshet-btn-primary`、它的 CSS 变量、它的定位规则 left=行左 / top=行底+6 /
// width=行宽、`data-dshet-editor` 标记）：这样"一样"不是像，而是同一套视觉与结构；
// 它在场时我甚至不注入 CSS，直接用它的样式表，避免两份规则打架。
//
// 它的编辑器**不在行内**（放在 `.dshet-layer` 覆盖层里绝对定位），所以要把编辑器
// 对回某一行只能靠几何：它的定位规则是确定的，反解即可（下面 `rowOfEditor`）。

const LAYER_CLASS = 'dshet-layer'
const EDITOR_CLASS = 'dshet-editor'
const FIELD_CLASS = 'dshet-field'
const FOOTER_CLASS = 'dshet-footer'
const BTN_CLASS = 'dshet-btn'
const BTN_PRIMARY_CLASS = 'dshet-btn dshet-btn-primary'

/** 我的按钮在它页脚里的标记，避免重复插入。 */
export const BRIDGE_MARKER = 'dsh-rewind-pro-bridge-action'

/** 它的行动作（那支笔）——用它自己的类名与 aria 双重判定，任一命中即可。 */
/** 它的插件是否已加载到这一页（行里有它的笔，或页面上有它的图层）。 */
export function hasForeignPlugin(doc: Document): boolean {
  return doc.querySelector('.dshet-row-action') !== null
}

export function hasForeignEditAction(row: HTMLElement): boolean {
  return (
    row.querySelector('.dshet-row-action') !== null ||
    row.querySelector('button[aria-label="编辑这条消息"]') !== null
  )
}

/**
 * 只在它的样式表**不在场**时注入基础样式。
 *
 * 它在场时用它自己的规则，这样两边的编辑器长得一模一样；不在场时用这份等价副本
 * （变量与规则都抄自它的实现）。
 */
export function ensureBaseStyles(doc: Document): void {
  const already = Array.from(doc.querySelectorAll('style')).some((style) =>
    (style.textContent ?? '').includes(`.${EDITOR_CLASS}`),
  )
  if (already) return
  if (doc.getElementById('dsh-rewind-pro-dshet-base')) return
  const style = doc.createElement('style')
  style.id = 'dsh-rewind-pro-dshet-base'
  style.textContent = `
:root{--dshet-panel:rgba(255,255,255,.96);--dshet-field:rgba(244,247,252,.98);--dshet-chip:rgba(255,255,255,.82);--dshet-line:rgba(16,24,40,.16);--dshet-ink:#0f1524;--dshet-ink-dim:#4b5872;--dshet-hover:rgba(16,24,40,.07);--dshet-shadow:0 12px 32px rgba(9,18,40,.22);--dshet-accent:#4d6bfe;--dshet-on-accent:#fff}
.${LAYER_CLASS}{position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:40}
.${LAYER_CLASS} .${EDITOR_CLASS}{position:absolute;pointer-events:auto}
.${EDITOR_CLASS}{margin:0;border:1px solid var(--dshet-line);border-radius:16px;background:var(--dshet-panel);backdrop-filter:blur(18px) saturate(1.2);box-shadow:var(--dshet-shadow);color:var(--dshet-ink);transition:border-color .12s}
.${EDITOR_CLASS}:focus-within{border-color:var(--dsw-alias-button-primary-fill,var(--dshet-accent))}
.${EDITOR_CLASS} textarea{display:block;width:100%;min-height:47px;max-height:46vh;overflow-y:auto;resize:none;box-sizing:border-box;padding:11px 14px 0;border:0;background:transparent;color:inherit;font:inherit;outline:none}
.${FOOTER_CLASS}{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:4px 10px 10px}
.${BTN_CLASS}{padding:6px 16px;border:1px solid var(--dshet-line);border-radius:999px;background:var(--dshet-field);color:var(--dshet-ink);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background-color .12s,border-color .12s}
.dshet-btn-primary{border-color:var(--dsw-alias-button-primary-fill,var(--dshet-accent));background:var(--dsw-alias-button-primary-fill,var(--dshet-accent));color:var(--dsw-alias-label-primary-foreground,var(--dshet-on-accent))}
`
  doc.head.append(style)
}

/**
 * 我的图层：**必须是我自己的那一个**。
 *
 * 一开始我复用"页面上任何一个 `.dshet-layer`"，结果实测被它的插件清掉了 ——
 * 它在自己图层里清理未知子节点，而我的编辑器正好落在里面。所以类名保持
 * `.dshet-layer`（外观与它一致），但用 `data-rewind-pro-layer` 认自己的那个。
 */
const OWN_LAYER_ATTR = 'data-rewind-pro-layer'

function layerOf(doc: Document): HTMLElement {
  const existing = doc.querySelector<HTMLElement>(`[${OWN_LAYER_ATTR}]`)
  if (existing) return existing
  const layer = doc.createElement('div')
  layer.className = LAYER_CLASS
  layer.setAttribute('data-dshet-layer', '1')
  layer.setAttribute(OWN_LAYER_ATTR, '1')
  doc.body.append(layer)
  return layer
}

/** 它的定位规则：left=行左、top=行底+6、width=行宽。 */
function placeUnderRow(editor: HTMLElement, row: HTMLElement): void {
  const rect = row.getBoundingClientRect()
  editor.style.left = `${String(Math.round(rect.left))}px`
  editor.style.top = `${String(Math.round(rect.bottom + 6))}px`
  editor.style.width = `${String(Math.round(rect.width))}px`
}

/**
 * 反解：某个编辑器属于哪一行。
 *
 * 它的 `data-dshet-for` 是 seq 编码（`6211|0|0||n|A|k0`），和 DOM 行的
 * `data-chat-flow-key` 不是同一套，没法直接对。但定位规则是确定的，所以按
 * 几何反解：行左 == 编辑器左、行宽 == 编辑器宽、行底 + 6 == 编辑器顶。
 */
export function rowOfEditor(editor: HTMLElement, rows: readonly HTMLElement[]): HTMLElement | null {
  const left = Number.parseFloat(editor.style.left)
  const top = Number.parseFloat(editor.style.top)
  const width = Number.parseFloat(editor.style.width)
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width)) return null
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2
  for (const row of rows) {
    const rect = row.getBoundingClientRect()
    if (near(rect.left, left) && near(rect.width, width) && near(rect.bottom + 6, top)) return row
  }
  return null
}

export interface OwnEditorOptions {
  doc: Document
  row: HTMLElement
  text: string
  /** 主按钮文案（我的情形是"分页重跑"）。 */
  submitLabel: string
  /** 取消按钮文案；默认取本地化里的 `editor.cancel`，取不到就用"取消"。 */
  cancelLabel?: string
  onSubmit: (text: string) => void
}

export interface OwnEditorHandle {
  close: () => void
}

/**
 * 我的行内编辑器：结构、类名、定位、按钮样式全部与它一致，唯一区别是
 * 页脚是 `[取消][分页重跑]`（只装我时的形态）。
 */
export function openOwnEditor(options: OwnEditorOptions): OwnEditorHandle {
  const { doc, row } = options
  ensureBaseStyles(doc)

  const editor = doc.createElement('div')
  editor.className = EDITOR_CLASS
  editor.setAttribute('data-dshet-editor', '1')
  editor.setAttribute('data-rewind-pro-editor', '1')

  const field = doc.createElement('div')
  field.className = FIELD_CLASS
  const area = doc.createElement('textarea')
  area.rows = 1
  area.spellcheck = false
  area.value = options.text
  area.setAttribute('aria-label', '编辑这条消息')
  area.addEventListener('input', () => {
    area.style.height = 'auto'
    area.style.height = `${String(area.scrollHeight)}px`
  })
  field.append(area)

  const footer = doc.createElement('div')
  footer.className = FOOTER_CLASS

  const cancel = doc.createElement('button')
  cancel.type = 'button'
  cancel.className = BTN_CLASS
  cancel.textContent = options.cancelLabel ?? '取消'
  cancel.addEventListener('click', () => {
    handle.close()
  })

  const submit = doc.createElement('button')
  submit.type = 'button'
  submit.className = BTN_PRIMARY_CLASS
  submit.textContent = options.submitLabel
  submit.addEventListener('click', () => {
    const text = area.value
    handle.close()
    options.onSubmit(text)
  })

  footer.append(cancel, submit)
  editor.append(field, footer)

  const layer = layerOf(doc)
  layer.append(editor)
  placeUnderRow(editor, row)
  area.focus()
  area.setSelectionRange(area.value.length, area.value.length)

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      handle.close()
    }
  }
  doc.addEventListener('keydown', onKey, true)

  const handle: OwnEditorHandle = {
    close() {
      doc.removeEventListener('keydown', onKey, true)
      editor.remove()
      if (layer.childElementCount === 0) layer.remove()
    },
  }
  return handle
}

export interface BridgeOptions {
  doc: Document
  /** 页脚里我的按钮叫什么。 */
  label: string
  /** 编辑器所属的行（几何反解），以及编辑器里的当前文本。 */
  onAction: (row: HTMLElement, text: string) => void
  /** 用于反解行的行选择器（与翻页器保持一致）。 */
  rowSelectors: string[]
}

/**
 * 把「分页重跑」接进**它的**编辑器页脚：插在它的主按钮（保存）左侧。
 *
 * 于是三档配置一次性成立：
 *   * 只有它：页脚原样 `[取消][保存]`（我不在场就不动）
 *   * 只有我：我自己的编辑器 `[取消][分页重跑]`
 *   * 两个都有：一支笔（我的那支让位），页脚 `[取消][分页重跑][保存]`
 */
export function bridgeForeignEditor(options: BridgeOptions): { refresh: () => void; dispose: () => void } {
  const { doc } = options
  let disposed = false

  const refresh = (): void => {
    if (disposed) return
    const editors = Array.from(doc.querySelectorAll<HTMLElement>(`.${EDITOR_CLASS}`))
    for (const editor of editors) {
      // 我自己开的编辑器不需要桥接
      if (editor.hasAttribute('data-rewind-pro-editor')) continue
      if (editor.querySelector(`.${BRIDGE_MARKER}`)) continue
      const footer = editor.querySelector<HTMLElement>(`.${FOOTER_CLASS}`)
      if (!footer) continue

      const button = doc.createElement('button')
      button.type = 'button'
      button.className = `${BTN_CLASS} ${BRIDGE_MARKER}`
      button.textContent = options.label
      button.addEventListener('click', () => {
        const rows = Array.from(doc.querySelectorAll<HTMLElement>(options.rowSelectors.join(',')))
        const row = rowOfEditor(editor, rows)
        const area = editor.querySelector('textarea')
        const text = area instanceof HTMLTextAreaElement ? area.value : ''
        // 先"用它的取消"关掉编辑器：这是它自己的关闭路径，不会触发它的保存
        const cancel = Array.from(footer.querySelectorAll('button')).find(
          (candidate) => (candidate.textContent ?? '').trim() === '取消',
        )
        cancel?.click()
        if (row) options.onAction(row, text)
      })

      // 插到它的主按钮（保存）**左边**：用户要求 [取消][分页重跑][保存]
      const primary = footer.querySelector<HTMLElement>('.dshet-btn-primary')
      if (primary) footer.insertBefore(button, primary)
      else footer.append(button)
    }
  }

  const observer = new MutationObserver(() => {
    refresh()
  })
  observer.observe(doc.body, { childList: true, subtree: true })
  refresh()

  return {
    refresh,
    dispose() {
      disposed = true
      observer.disconnect()
      for (const node of Array.from(doc.querySelectorAll(`.${BRIDGE_MARKER}`))) node.remove()
    },
  }
}

// Styles live with the client: the bundle is a single file, so no CSS import
// (the loader closure has no CSS pipeline). Everything uses the harness design
// tokens with fallbacks, which is what makes light/dark work for free.
// No Tailwind, no icon font: the icons are hand-written 16px SVG paths.

export const STYLE_ID = 'dsh-rewind-pro-styles'

export const CSS = `
/* Native turn-tail action: sits in the harness's own action row, so it wears the
   same size and reveal behaviour as the built-in icons next to it. */
.dsh-rewind-pro-turn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, inherit);
  cursor: pointer;
}
.dsh-rewind-pro-turn:hover {
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-hover, rgba(127,127,127,0.12));
}
.dsh-rewind-pro-turn[data-active='true'] { color: var(--dsw-alias-brand, #4d6bfe); }

/* The injected row action. It is a sibling of the shell's own icon buttons, so
   it only needs to read as one of them: no positioning, no floating card, and
   the row's own hover reveal keeps working because the shell styles the row,
   not us. */
.dsh-rewind-pro-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, inherit);
  font: inherit;
  line-height: 1;
  cursor: pointer;
}
.dsh-rewind-pro-btn:hover {
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-hover, rgba(127,127,127,0.12));
}
.dsh-rewind-pro-btn:focus-visible { outline: 1px solid var(--dsw-alias-brand, #4d6bfe); outline-offset: 1px; }
.dsh-rewind-pro-btn[data-active='true'] { color: var(--dsw-alias-brand, #4d6bfe); }

/* 版本树翻页器。它贴在行自己的动作区里，所以必须"安静"：12px、一律不换行、
   只有真的存在多个版本时才摆出 ‹ n/N ›。动作按钮用图标（✎ / ⟳）而不是中文，
   因为 22px 的按钮里塞中文一定会被挤成竖排 —— 那正是它一开始很难看的原因。 */
.dsh-rewind-pro-pager {
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 2px;
  margin-left: 2px;
  font-size: 12px;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary, inherit);
  white-space: nowrap;
}
.dsh-rewind-pro-pager-stepper { display: inline-flex; align-items: center; gap: 1px; white-space: nowrap; }
.dsh-rewind-pro-pager-label { opacity: 0.7; white-space: nowrap; }
.dsh-rewind-pro-pager-count {
  min-width: 22px;
  padding: 0 1px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsh-rewind-pro-pager-sep {
  width: 1px;
  height: 12px;
  margin: 0 3px;
  background: var(--dsw-alias-border, rgba(127, 127, 127, 0.3));
}
/* 图标按钮比 ↶ 再小一号，四个挤在一行也不至于抢戏 */
.dsh-rewind-pro-pager-btn { width: 18px; height: 18px; border-radius: 5px; }
/* 笔要和 dsh-edit-turn 的行动作看起来一致：它是 28×28、圆角 28、内边距 6。
   单独把"编辑"那支放大到同尺寸，两支笔并排时（过渡期）不会一大一小。 */
.dsh-rewind-pro-pager-btn[aria-label='编辑'] {
  width: 28px;
  height: 28px;
  border-radius: 28px;
  padding: 6px;
}

.dsh-rewind-pro-pill,
.dsh-rewind-pro-banner,
.dsh-rewind-pro-popover,
.dsh-rewind-pro-panel {
  background: var(--dsw-alias-bg-float, #fff);
  color: var(--dsw-alias-fg, #111);
  border: 1px solid var(--dsw-alias-border, rgba(127,127,127,0.3));
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.12);
  font-size: 13px;
}

.dsh-rewind-pro-pill {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  z-index: 45;
}

.dsh-rewind-pro-banner {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  z-index: 46;
}

.dsh-rewind-pro-popover,
.dsh-rewind-pro-panel {
  position: fixed;
  z-index: 47;
  padding: 12px;
  max-width: 420px;
  max-height: 60vh;
  overflow: auto;
}

.dsh-rewind-pro-list { list-style: none; margin: 8px 0 0; padding: 0; }
.dsh-rewind-pro-list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.dsh-rewind-pro-list li[aria-selected='true'] {
  background: var(--dsw-alias-bg-hover, rgba(127,127,127,0.14));
}
.dsh-rewind-pro-muted { opacity: 0.65; font-size: 12px; }
.dsh-rewind-pro-row { display: flex; gap: 8px; align-items: center; }
.dsh-rewind-pro-danger { color: var(--dsw-alias-danger, #c0392b); }
`

/** Inject once; repeated mounts must not duplicate the sheet. */
export function ensureStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  doc.head.appendChild(style)
}

export function removeStyles(doc: Document = document): void {
  doc.getElementById(STYLE_ID)?.remove()
}

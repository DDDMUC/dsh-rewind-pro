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

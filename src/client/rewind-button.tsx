// The ↶ button inside each user turn's own action row.
//
// Mount rule: the button is injected INTO the message row, as one more child of
// the same flex container that already holds the shell's copy icon and any
// sibling plugin's icons — so the browser lays it out and there is no coordinate
// arithmetic to get wrong when the list scrolls or virtualises. This is how the
// neighbouring action plugins (dsh-edit-turn, dsh-delete-turn) do it, and the
// earlier absolutely-positioned overlay is why this one kept missing.
//
// React may re-render a row at any time and drop our node with it, so a
// MutationObserver re-asserts the button on every DOM pass. We never write into
// a React-managed *component*; we only add a sibling element and clean up after
// ourselves.
//
// Seq rule: the frontend writes no seq of any kind onto a message node, so the
// seq comes from the host's candidate list and is paired by text (see
// anchors.ts). An anchor without a matching candidate gets no button at all.

import { resolveAnchorSeqs, type CandidateLike } from './anchors.js'

export interface AnchorInfo {
  element: HTMLElement
  seq: number | null
  text: string
}

export interface RewindButtonLayerOptions {
  /** Selectors tried in order until one matches user turns. */
  selectors?: string[]
  onRewind: (seq: number, element: HTMLElement) => void
  /**
   * Host-reported seq mapping, as a getter: candidates arrive asynchronously
   * and change as the session grows, and a button must not need a remount for
   * that.
   */
  candidates: () => readonly CandidateLike[]
  activeSeq?: number | null
  label?: string
}

// The current chat flow renders every turn as a div[data-chat-flow-kind] and
// the harness CSS hooks the same attribute; the rest are older/other builds.
const DEFAULT_SELECTORS = [
  '[data-chat-flow-kind="user"]',
  '[data-message-role="user"]',
  '[data-role="user"]',
  '.dsw-message-user',
]

const BUTTON_CLASS = 'dsh-rewind-pro-btn'

/**
 * Interop marker published by the neighbouring action plugins.
 *
 * dsh-edit-turn / dsh-as-aistudio walk a row's children and hide every one that
 * is not theirs, exempting exactly `dshet-action-host`, `dshet-editor` and
 * `dshet-revision`. A button without that marker is collateral damage: present in
 * the DOM, clickable in tests, and invisible on screen — which is precisely the
 * report "turn aistudio off and it appears". Claim the marker they reserve for a
 * row child that acts, and keep our own class for styling.
 */
const ACTION_HOST_MARKER = 'dshet-action-host'

/** Same mark as icons.tsx IconRewind, kept here so this layer needs no renderer. */
const ICON_REWIND =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4v8"/><path d="M3 8h7a3.2 3.2 0 1 1-3.2 3.2"/><path d="M6.4 5.2 3.2 8l3.2 2.8"/></svg>'

/** A seq attribute only if this build really wrote one: never invent a number. */
function seqOf(element: HTMLElement): number | null {
  const raw =
    element.getAttribute('data-seq') ?? element.getAttribute('data-message-seq') ?? element.getAttribute('data-index')
  if (raw === null) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export function findAnchors(root: ParentNode, selectors: string[]): AnchorInfo[] {
  for (const selector of selectors) {
    const found = Array.from(root.querySelectorAll<HTMLElement>(selector))
    if (found.length === 0) continue
    return found.map((element) => ({ element, seq: seqOf(element), text: element.textContent ?? '' }))
  }
  return []
}

/**
 * Where in the row our button belongs: right after the row's last icon-only
 * button (copy, delete, retry, edit), so it reads as one more row action.
 * Class names are build-hashed, so the icon-only shape is the stable signal.
 */
function actionSlot(row: HTMLElement): HTMLElement | null {
  const icons = Array.from(row.querySelectorAll('button')).filter(
    (button) => !button.classList.contains(BUTTON_CLASS) && (button.textContent ?? '').trim() === '',
  )
  return icons.length > 0 ? icons[icons.length - 1] : null
}

export interface RewindButtonLayerHandle {
  /** Stop observing and remove every button this layer injected. */
  dispose: () => void
  /** Re-resolve the anchors against the current candidates. */
  refresh: () => void
}

/**
 * Keep one ↶ button inside every user row the host has a candidate for.
 *
 * Returns a handle whose dispose removes only our own nodes and listeners,
 * leaving the harness DOM as it was.
 */
export function mountRewindButtons(options: RewindButtonLayerOptions): RewindButtonLayerHandle {
  const selectors = options.selectors ?? DEFAULT_SELECTORS
  const label = options.label ?? 'Rewind to here'
  const mounted = new Map<HTMLElement, HTMLButtonElement>()
  let frame = 0

  const place = (row: HTMLElement, seq: number): void => {
    let button = mounted.get(row)
    if (!button || !button.isConnected) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = `${BUTTON_CLASS} ${ACTION_HOST_MARKER}`
      button.innerHTML = ICON_REWIND
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const target = Number(button?.dataset.seq)
        if (Number.isFinite(target)) options.onRewind(target, row)
      })
      mounted.set(row, button)
    }
    button.dataset.seq = String(seq)
    button.dataset.active = options.activeSeq !== null && options.activeSeq === seq ? 'true' : 'false'
    button.title = label
    button.setAttribute('aria-label', label)
    // Belt and braces: a plugin with a different exemption list could still hide
    // us, and an invisible button is worse than none — it looks like a missing
    // feature. Owning the visibility of our own node keeps the failure loud.
    if (button.style.display === 'none') button.style.display = ''

    // Attributes above are not observed, so only this insertion can re-trigger
    // the observer — and the next pass finds the button connected and stops.
    const slot = actionSlot(row)
    if (slot?.parentElement) {
      if (button.previousElementSibling !== slot || button.parentElement !== slot.parentElement) slot.after(button)
      return
    }
    if (button.parentElement !== row) row.append(button)
  }

  const scan = (): void => {
    frame = 0
    const found = findAnchors(document, selectors)
    const seqs = resolveAnchorSeqs(found, options.candidates())
    const live = new Set<HTMLElement>()

    found.forEach((anchor, index) => {
      const seq = seqs[index] ?? null
      // Unresolved means the host offered no candidate for this turn: no button,
      // because a guessed seq rewinds to the wrong turn.
      if (seq === null) return
      live.add(anchor.element)
      place(anchor.element, seq)
    })

    for (const [row, button] of Array.from(mounted)) {
      if (live.has(row) && row.isConnected && button.isConnected) continue
      button.remove()
      mounted.delete(row)
    }
  }

  const schedule = (): void => {
    if (frame) return
    frame = requestAnimationFrame(scan)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
  schedule()

  return {
    refresh: schedule,
    dispose() {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      for (const button of mounted.values()) button.remove()
      mounted.clear()
    },
  }
}

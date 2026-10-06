// The acceptance test for the ↶ bridge: the real layer, the real chat flow
// markup, a real click. The DOM never carries a seq, so the expected seq can
// only come from the host's candidate list.
//
// The contract under test is injection: the button becomes a sibling of the
// row's own icon buttons, so it is laid out by the browser instead of by
// coordinate arithmetic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountRewindButtons, type RewindButtonLayerHandle } from '../../src/client/rewind-button'

let handle: RewindButtonLayerHandle | null = null

/** The shell's own icon-only action button, which ours must sit next to. */
function iconAction(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.innerHTML = '<svg width="16" height="16"></svg>'
  return button
}

/** A chat flow item exactly as the harness renders it, action row included. */
function userTurn(text: string): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('data-chat-flow-kind', 'user')
  const stack = document.createElement('div')
  const bubble = document.createElement('div')
  bubble.textContent = text
  const actions = document.createElement('div')
  actions.append(iconAction('copy'), iconAction('delete'), iconAction('rerun'), iconAction('edit'))
  stack.append(bubble, actions)
  row.append(stack)
  return row
}

beforeEach(() => {
  document.body.innerHTML = ''
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 40,
    right: 320,
    bottom: 80,
    left: 20,
    width: 300,
    height: 40,
    x: 20,
    y: 40,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  handle?.dispose()
  handle = null
  vi.restoreAllMocks()
})

function buttons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.dsh-rewind-pro-btn'))
}

describe('mountRewindButtons', () => {
  it("injects one button per user turn, next to the row's own actions", async () => {
    const first = userTurn('write a parser')
    const second = userTurn('add tests')
    document.body.append(first, second)

    const onRewind = vi.fn()
    handle = mountRewindButtons({
      // Newest first, exactly as GET /candidates returns it.
      candidates: () => [
        { seq: 7, preview: 'add tests' },
        { seq: 3, preview: 'write a parser' },
      ],
      onRewind,
    })

    await vi.waitFor(() => expect(buttons()).toHaveLength(2))
    expect(first.contains(buttons()[0])).toBe(true)
    expect(second.contains(buttons()[1])).toBe(true)
    // Sibling of the row's last icon action, i.e. laid out by the row itself.
    expect(buttons()[0].previousElementSibling?.getAttribute('aria-label')).toBe('edit')
    // Carries the marker the neighbouring action plugins exempt from their
    // "hide every child that is not ours" pass — without it the button is
    // present but invisible whenever dsh-as-aistudio is loaded.
    expect(buttons()[0].classList.contains('dshet-action-host')).toBe(true)

    buttons()[0].click()
    buttons()[1].click()
    expect(onRewind).toHaveBeenNthCalledWith(1, 3, first)
    expect(onRewind).toHaveBeenNthCalledWith(2, 7, second)
  })

  it('skips a turn the host has no candidate for instead of guessing a seq', async () => {
    document.body.append(userTurn('write a parser'), userTurn('text the host never saw'))

    handle = mountRewindButtons({
      candidates: () => [{ seq: 3, preview: 'write a parser' }],
      onRewind: vi.fn(),
    })

    await vi.waitFor(() => expect(buttons()).toHaveLength(1))
  })

  it('resolves buttons against candidates that arrive after mount', async () => {
    document.body.append(userTurn('write a parser'))

    let candidates: Array<{ seq: number; preview: string }> = []
    handle = mountRewindButtons({ candidates: () => candidates, onRewind: vi.fn() })

    // Let the first scan (rAF-batched) finish with an empty candidate list.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(buttons()).toHaveLength(0)

    candidates = [{ seq: 3, preview: 'write a parser' }]
    handle.refresh()

    await vi.waitFor(() => expect(buttons()).toHaveLength(1))
  })

  it('takes its own visibility back when another plugin hides it', async () => {
    const row = userTurn('write a parser')
    document.body.append(row)
    handle = mountRewindButtons({ candidates: () => [{ seq: 3, preview: 'write a parser' }], onRewind: vi.fn() })
    await vi.waitFor(() => expect(buttons()).toHaveLength(1))

    // A foreign row pass writes display:none on children it does not know.
    buttons()[0].style.display = 'none'
    handle.refresh()
    await vi.waitFor(() => expect(buttons()[0].style.display).toBe(''))
  })

  it('puts the button back after the row is re-rendered', async () => {
    const row = userTurn('write a parser')
    document.body.append(row)
    handle = mountRewindButtons({ candidates: () => [{ seq: 3, preview: 'write a parser' }], onRewind: vi.fn() })
    await vi.waitFor(() => expect(buttons()).toHaveLength(1))

    // A re-render replaces the row's children wholesale; our node goes with them.
    // The replacement keeps the same content, because a row whose text changed
    // legitimately stops matching its candidate and then gets no button at all.
    const rerendered = userTurn('write a parser')
    row.replaceChildren(...Array.from(rerendered.childNodes))
    await vi.waitFor(() => expect(buttons()).toHaveLength(1))
    expect(row.contains(buttons()[0])).toBe(true)
  })
})

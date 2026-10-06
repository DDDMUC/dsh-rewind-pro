// Keyboard navigation for the /rewind candidate list: pure, so it can be
// tested without a DOM. Wrapping is intentional — the list is short and people
// expect to loop from the bottom back to the top.

export interface SelectionState {
  index: number
  count: number
}

export function moveSelection(current: SelectionState, delta: number): number {
  const { index, count } = current
  if (count <= 0) return -1
  if (index < 0) return delta > 0 ? 0 : count - 1
  const next = (index + delta) % count
  return next < 0 ? next + count : next
}

export function clampSelection(index: number, count: number): number {
  if (count <= 0) return -1
  if (index < 0) return 0
  return Math.min(index, count - 1)
}

// Plan is a pure function: same messages + same target => same impact list.
// The impact list must be honest about shell calls it cannot undo.

import { describe, expect, it } from 'vitest'
import { listCandidates, planRewind } from '../../src/core/plan'
import type { MessageLite } from '../../src/core/types'

const messages: MessageLite[] = [
  { seq: 1, role: 'user', text: 'write a file' },
  {
    seq: 2,
    role: 'assistant',
    text: 'done',
    toolCalls: [{ name: 'write', path: 'src/a.ts', write: true }],
  },
  { seq: 3, role: 'user', text: 'now run the tests' },
  {
    seq: 4,
    role: 'assistant',
    text: 'running',
    toolCalls: [
      { name: 'bash', shell: true },
      { name: 'write', path: 'src/a.ts', write: true },
      { name: 'edit', path: 'src/b.ts', write: true },
    ],
  },
  { seq: 5, role: 'user', text: 'stop', steering: true },
]

describe('planRewind', () => {
  it('lists the turns that will be withdrawn, from the target onwards', () => {
    const plan = planRewind(messages, 3)
    expect(plan.targetSeq).toBe(3)
    expect(plan.turns.map((t) => t.seq)).toEqual([3, 4, 5])
    expect(plan.turns[2].kind).toBe('steering')
    expect(plan.turns[0].kind).toBe('user')
  })

  it('collects touched files once, keeping the newest detail', () => {
    const plan = planRewind(messages, 2)
    const byPath = Object.fromEntries(plan.files.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(byPath['src/a.ts'].action).toBe('restore')
    expect(byPath['src/a.ts'].detail).toContain('write')
  })

  it('counts shell calls it cannot undo', () => {
    expect(planRewind(messages, 3).shellCalls).toBe(1)
    expect(planRewind(messages, 1).shellCalls).toBe(1)
    expect(planRewind(messages, 5).shellCalls).toBe(0)
  })

  it('truncates long previews to a single short line', () => {
    const long = 'x'.repeat(200)
    const plan = planRewind([{ seq: 1, role: 'user', text: long }], 1)
    expect(plan.turns[0].preview.length).toBeLessThanOrEqual(80)
  })

  it('reports a file it will have to rescue when it is not on disk', () => {
    const plan = planRewind(
      [
        { seq: 1, role: 'user', text: 'create' },
        { seq: 2, role: 'assistant', text: 'ok', toolCalls: [{ name: 'write', path: 'new.ts', write: true }] },
      ],
      1,
      { existing: () => false },
    )
    expect(plan.files[0].action).toBe('recreate')
  })
})

describe('listCandidates', () => {
  it('offers user turns newest first with stable ordinals', () => {
    const candidates = listCandidates(messages)
    expect(candidates.map((c) => c.seq)).toEqual([5, 3, 1])
    expect(candidates.map((c) => c.ordinal)).toEqual([3, 2, 1])
    expect(candidates[0].preview).toBe('stop')
  })
})

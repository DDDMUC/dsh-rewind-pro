// Commands and the clean export: plain text a human reads, plus a transcript
// with every rewound turn and every rewound file edit stripped out.

import { describe, expect, it } from 'vitest'
import { buildCleanExport, formatImpact } from '../../src/host/export'
import { formatCandidates, formatHistory } from '../../src/host/commands'
import type { HistoryEntry, ImpactPlan, MessageLite, RewindCandidate } from '../../src/core/types'

const messages: MessageLite[] = [
  { seq: 1, role: 'user', text: 'write a parser' },
  { seq: 2, role: 'assistant', text: 'sure', toolCalls: [{ name: 'write', path: 'src/parser.ts', write: true }] },
  { seq: 3, role: 'user', text: 'now add tests' },
  { seq: 4, role: 'assistant', text: 'ok', toolCalls: [{ name: 'bash', shell: true }] },
]

const candidates: RewindCandidate[] = [
  { seq: 3, preview: 'now add tests', ordinal: 2 },
  { seq: 1, preview: 'write a parser', ordinal: 1 },
]

const history: HistoryEntry[] = [
  { opId: 'm1', kind: 'mark', targetSeq: 3, time: 1, reversible: true },
  { opId: 'k1', kind: 'commit', targetSeq: 3, time: 2, reversible: true },
  { opId: 'u1', kind: 'unwind', targetSeq: 3, time: 3, reversible: false },
]

const impact: ImpactPlan = {
  targetSeq: 3,
  turns: [
    { seq: 3, preview: 'now add tests', kind: 'user' },
    { seq: 4, preview: 'ok', kind: 'assistant' },
  ],
  files: [{ path: 'src/parser.ts', action: 'restore', detail: 'write' }],
  shellCalls: 1,
}

describe('formatCandidates', () => {
  it('numbers targets for keyboard navigation', () => {
    const text = formatCandidates(candidates)
    expect(text).toContain('1.')
    expect(text).toContain('now add tests')
    expect(text.split('\n')).toHaveLength(2)
  })

  it('says when there is nothing to rewind to', () => {
    expect(formatCandidates([])).toMatch(/nothing|no rewind target/i)
  })
})

describe('formatHistory', () => {
  it('marks which entries can be undone', () => {
    const text = formatHistory(history)
    expect(text).toContain('commit')
    expect(text).toMatch(/undo|reversible|revert/i)
  })
})

describe('formatImpact', () => {
  it('is honest about shell calls it cannot undo', () => {
    const text = formatImpact(impact)
    expect(text).toContain('2 turns')
    expect(text).toContain('src/parser.ts')
    expect(text).toMatch(/shell|command/i)
  })
})

describe('buildCleanExport', () => {
  it('removes the hidden turns from the transcript', () => {
    const text = buildCleanExport(messages, [{ start: 3, end: 4 }])
    expect(text).toContain('write a parser')
    expect(text).not.toContain('now add tests')
  })

  it('says what was removed instead of pretending it never happened', () => {
    const text = buildCleanExport(messages, [{ start: 3, end: 4 }])
    expect(text).toMatch(/removed|hidden|omitted/i)
  })

  it('leaves the transcript untouched when nothing is hidden', () => {
    const text = buildCleanExport(messages, [])
    expect(text).toContain('now add tests')
    expect(text).not.toMatch(/removed 2 turns/i)
  })
})

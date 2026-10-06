// Anchor resolution: the DOM exposes no seq for a user turn, so the buttons
// rely on the host's candidate list. A wrong pairing rewinds the wrong turns,
// which is why an unmatched anchor must resolve to null (no button at all).

import { describe, expect, it } from 'vitest'
import { normalizeAnchorText, resolveAnchorSeqs } from '../../src/client/anchors'

/** The host's preview, copied from core/plan.ts normalizePreview. */
function preview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

describe('normalizeAnchorText', () => {
  it('collapses whitespace the way the host preview does', () => {
    expect(normalizeAnchorText('  write\n a   parser ')).toBe('write a parser')
  })

  it('leaves short text alone', () => {
    expect(normalizeAnchorText('write a parser')).toBe('write a parser')
  })
})

describe('resolveAnchorSeqs', () => {
  it('matches an anchor to its candidate by text', () => {
    expect(resolveAnchorSeqs([{ text: 'write a parser', seq: null }], [{ seq: 4, preview: 'write a parser' }])).toEqual([4])
  })

  it('pairs document order with the newest-first candidate list', () => {
    const anchors = [
      { text: 'first question', seq: null },
      { text: 'second question', seq: null },
    ]
    const candidates = [
      { seq: 8, preview: 'second question' },
      { seq: 3, preview: 'first question' },
    ]
    expect(resolveAnchorSeqs(anchors, candidates)).toEqual([3, 8])
  })

  it('resolves duplicate texts in document order, consuming each candidate once', () => {
    const anchors = [
      { text: 'same question', seq: null },
      { text: 'same question', seq: null },
    ]
    const candidates = [
      { seq: 5, preview: 'same question' },
      { seq: 2, preview: 'same question' },
    ]
    expect(resolveAnchorSeqs(anchors, candidates)).toEqual([2, 5])
  })

  it('returns null rather than guessing when nothing matches', () => {
    const anchors = [
      { text: 'never seen by the host', seq: null },
      { text: '  ', seq: null },
    ]
    expect(resolveAnchorSeqs(anchors, [{ seq: 3, preview: 'write a parser' }])).toEqual([null, null])
  })

  it('matches a candidate whose preview was capped with an ellipsis', () => {
    const long = 'a'.repeat(120)
    expect(resolveAnchorSeqs([{ text: long, seq: null }], [{ seq: 6, preview: preview(long) }])).toEqual([6])
  })

  it('tolerates trailing UI text inside the DOM node', () => {
    expect(resolveAnchorSeqs([{ text: 'write a parser Copy 12:04', seq: null }], [{ seq: 6, preview: 'write a parser' }])).toEqual([6])
  })

  // The real user row renders attachment cards BEFORE the bubble, so a turn
  // that carried a file leads with the file name and its metadata.
  it('matches a turn whose DOM text leads with attachment chrome', () => {
    const text = 'report.pdf PDF 240 KB please summarise this'
    expect(resolveAnchorSeqs([{ text, seq: null }], [{ seq: 9, preview: 'please summarise this' }])).toEqual([9])
  })

  it('does not let a short preview match by containment', () => {
    // "ok" is under the identification floor: it must stay unresolved rather
    // than claim whichever turn happens to contain those two letters.
    expect(resolveAnchorSeqs([{ text: 'smoke test the ok path', seq: null }], [{ seq: 4, preview: 'ok' }])).toEqual([null])
  })

  it('prefers a prefix match over a containment match for the same candidate', () => {
    const anchors = [
      { text: 'attachment card then talk about widgets', seq: null },
      { text: 'talk about widgets', seq: null },
    ]
    const candidates = [
      { seq: 7, preview: 'talk about widgets' },
      { seq: 2, preview: 'talk about widgets' },
    ]
    // The exact prefix claims the newest candidate; the chrome-leading row gets
    // the older one by containment instead of colliding.
    expect(resolveAnchorSeqs(anchors, candidates)).toEqual([2, 7])
  })

  it('keeps a seq the DOM already carried and does not consume a candidate', () => {
    const anchors = [{ text: 'write a parser', seq: 11 }]
    expect(resolveAnchorSeqs(anchors, [{ seq: 6, preview: 'write a parser' }])).toEqual([11])
  })

  it('has one result per anchor, in order', () => {
    const anchors = [
      { text: 'nothing here', seq: null },
      { text: 'second question', seq: null },
    ]
    expect(resolveAnchorSeqs(anchors, [{ seq: 8, preview: 'second question' }])).toEqual([null, 8])
  })
})

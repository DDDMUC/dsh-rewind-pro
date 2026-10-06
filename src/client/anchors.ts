// Pairing DOM user turns with the host's rewind candidates.
//
// Why this module exists: the harness keeps each turn's session event seq in
// its own node state and never writes it to the DOM (there is no data-seq and
// no equivalent attribute), so an overlay that only reads the DOM cannot know
// which seq a user turn belongs to. The host does expose exactly that mapping
// (`GET /candidates` -> `{ seq, preview }`), so the client pairs the two by
// text instead of guessing a position.
//
// Pure and dependency-free on purpose: this decides which turn a click
// rewinds to, and a wrong answer hides the wrong history.

/** Same flattening as core/plan.ts normalizePreview, minus its length cap. */
export function normalizeAnchorText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * normalizePreview cuts a long message with a trailing ellipsis, so that last
 * character says nothing about the text: drop it before comparing.
 */
function stripEllipsis(text: string): string {
  return text.endsWith('…') ? text.slice(0, -1) : text
}

/**
 * Equal, or one a prefix of the other, over the shorter length. A truncated
 * preview still matches its full text, and a DOM node carrying trailing UI text
 * (reference summaries, action rows) still matches the host's message preview.
 */
function prefixMatch(text: string, preview: string): boolean {
  const limit = Math.min(text.length, preview.length)
  if (limit === 0) return false
  return text.slice(0, limit) === preview.slice(0, limit)
}

/**
 * The chat row prints the send time ahead of the bubble, so an anchor's text
 * begins with chrome like "22:34" or "10月4日 22:34" and no prefix of the message
 * would ever match it. The stamp is chrome, not content: drop it before
 * comparing. Short messages lean on this — "刷新了" is three characters, and a
 * leading stamp alone would eat the whole match.
 *
 * Shapes the shell uses: a bare clock, "10月4日 22:34", "2026/10/4 22:34".
 */
function stripClock(text: string): string {
  const clock = '\\d{1,2}:\\d{2}(?::\\d{2})?'
  const date = '(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}月\\d{1,2}日)'
  return text.replace(new RegExp(`^(?:${date}\\s*)?${clock}\\s*|^${date}\\s+`), '')
}

/**
 * Shorter than this, a containment test stops identifying anything ("ok" sits
 * inside half the page), so the loose branch refuses to look at it.
 */
const MIN_CONTAINMENT = 4

/**
 * Second pass, for the one shape a prefix cannot cover: the user row renders
 * its attachment cards BEFORE the bubble, so a turn that carried a file leads
 * with the file name and its metadata ("report.png PNG 12 KB <the message>"),
 * which no prefix of the text will ever match. Accept containment instead, but
 * only over an identifying length and still under the caller's
 * one-consumption-per-candidate rule.
 */
function containsMatch(text: string, preview: string): boolean {
  const needle = preview.length <= text.length ? preview : text
  const haystack = needle === preview ? text : preview
  if (needle.length < MIN_CONTAINMENT) return false
  return haystack.includes(needle)
}

export interface AnchorLike {
  /** Seq a build happened to expose on the DOM element; usually null. */
  seq: number | null
  text: string
}

export interface CandidateLike {
  seq: number
  preview: string
}

/**
 * Accept a prefix match, or — for the one shape a prefix cannot cover — a
 * containment match.
 *
 * The user row renders its attachment cards BEFORE the bubble, so a turn that
 * carried a file leads with the file name and its metadata ("report.png PNG
 * 12 KB <the message>"), which no prefix of the text will ever match.
 *
 * Both are tried in ONE pass on purpose. Anchors are visited in document order
 * and each takes the oldest still-unclaimed candidate, so two identical turns
 * stay in order; splitting this into a strict pass followed by a loose one
 * would let the loose pass hand the newer candidate to the older turn.
 */
function sameTurn(text: string, preview: string): boolean {
  return prefixMatch(text, preview) || containsMatch(text, preview)
}

/**
 * One entry per anchor, in the same order.
 *
 * A number is a seq the host confirmed. `null` means "show no button": a
 * guessed seq would rewind to the wrong turn, which is worse than offering
 * nothing.
 *
 * Candidates arrive newest-first (that is the order /rewind lists them in),
 * and anchors are read in document order, i.e. oldest first — so the candidate
 * list is reversed here and each candidate is consumed at most once, which is
 * what keeps two identical texts on two different turns.
 */
export function resolveAnchorSeqs(
  anchors: readonly AnchorLike[],
  candidates: readonly CandidateLike[],
): Array<number | null> {
  const pending = [...candidates].reverse()
  return anchors.map((anchor) => {
    if (typeof anchor.seq === 'number' && Number.isFinite(anchor.seq)) return anchor.seq
    const text = stripClock(stripEllipsis(normalizeAnchorText(anchor.text)))
    if (!text) return null
    const index = pending.findIndex((candidate) =>
      sameTurn(text, stripEllipsis(normalizeAnchorText(candidate.preview))),
    )
    if (index < 0) return null
    const [matched] = pending.splice(index, 1)
    return matched.seq
  })
}

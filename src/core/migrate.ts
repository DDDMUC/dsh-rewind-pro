// Legacy marker migration.
//
// Two older rewind plugins left markers on disk in slightly different shapes.
// We read them defensively (never throw, never rewrite the original), describe
// what they meant, and emit ledger ops that reproduce the same hidden state
// under the new model. The scan is pure/dry-run; appending is the host's call.

import type { HiddenRange, LedgerOp, Strategy } from './types.js'

export type LegacySource = 'xsjustc' | 'sirilee' | 'unknown'

export interface LegacyMarkerFile {
  path: string
  content: string
}

export interface LegacyMigration {
  source: LegacySource
  path: string
  strategy: Strategy
  ranges: HiddenRange[]
  /** mark+commit pairs; appending them reproduces the legacy state. */
  ops: LedgerOp[]
  warnings: string[]
}

const EPOCH = 'legacy'
const MARKER_HINT = /rewind|rollback|rewound/i

/** Recognise a marker by path or by a key only a rewind plugin would write. */
function isMarker(path: string, content: unknown): boolean {
  if (MARKER_HINT.test(path)) return true
  if (!content || typeof content !== 'object') return false
  const keys = Object.keys(content as Record<string, unknown>)
  return keys.some((key) => /hidden|range|mask|collapse|surface|rewind/i.test(key))
}

type RawRange = Record<string, unknown> | [unknown, unknown] | number

function toRange(raw: RawRange): HiddenRange | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { start: raw, end: raw }
  if (Array.isArray(raw)) {
    const [start, end] = raw
    if (typeof start === 'number' && typeof end === 'number') return { start: Math.min(start, end), end: Math.max(start, end) }
    return null
  }
  if (raw && typeof raw === 'object') {
    const start = (raw.start ?? raw.from ?? raw.begin) as unknown
    const end = (raw.end ?? raw.to ?? raw.finish) as unknown
    if (typeof start === 'number' && typeof end === 'number') return { start: Math.min(start, end), end: Math.max(start, end) }
    if (typeof start === 'number') return { start, end: start }
  }
  return null
}

/** `{from,to}` vs `{start,end}` vs `[start,end]` vs `surfaceOps` — accept all. */
function extractRanges(content: Record<string, unknown>): HiddenRange[] {
  const buckets = [content.hiddenRanges, content.ranges, content.masked, content.hidden, content.surfaceOps, content.collapsed]
  const ranges: HiddenRange[] = []
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue
    for (const raw of bucket as RawRange[]) {
      const range = toRange(raw)
      if (range) ranges.push(range)
    }
  }
  return ranges
}

function detectSource(path: string, content: Record<string, unknown>): LegacySource {
  const text = `${path} ${Object.keys(content).join(' ')}`
  if (/surface|collapse/i.test(text)) return 'sirilee'
  if (/hidden|range|mask/i.test(text)) return 'xsjustc'
  return 'unknown'
}

export function scanLegacyMarkers(files: readonly LegacyMarkerFile[]): LegacyMigration[] {
  const migrations: LegacyMigration[] = []

  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(file.content)
    } catch {
      // Unreadable markers are reported, never fatal: the session still opens.
      if (MARKER_HINT.test(file.path)) {
        migrations.push({
          source: 'unknown',
          path: file.path,
          strategy: 'derive-patch',
          ranges: [],
          ops: [],
          warnings: [`unreadable marker at ${file.path}: JSON parse failed; left untouched`],
        })
      }
      continue
    }

    if (!isMarker(file.path, parsed)) continue
    const content = parsed as Record<string, unknown>
    const ranges = extractRanges(content)
    if (ranges.length === 0) continue

    const source = detectSource(file.path, content)
    // A surface-shaped marker means the old plugin folded the tail away for
    // good; we must not pretend it is undoable.
    const strategy: Strategy = source === 'sirilee' ? 'surface-op' : 'derive-patch'

    const ops: LedgerOp[] = []
    ranges.forEach((range, index) => {
      const markId = `legacy-${index}-mark`
      ops.push(
        { kind: 'mark', opId: markId, targetSeq: range.start, strategy, time: 0, epoch: EPOCH },
        {
          kind: 'commit',
          opId: `legacy-${index}-commit`,
          refOpId: markId,
          range,
          strategy,
          time: 0,
          epoch: EPOCH,
        },
      )
    })

    migrations.push({ source, path: file.path, strategy, ranges, ops, warnings: [] })
  }

  return migrations
}

/** Quiet badge for the UI: something was adopted, but nobody needs a modal. */
export function summarizeMigration(migrations: readonly LegacyMigration[]): {
  count: number
  sources: LegacySource[]
  badge: string | null
} {
  const adopted = migrations.filter((migration) => migration.ranges.length > 0)
  if (adopted.length === 0) return { count: 0, sources: [], badge: null }
  const sources = [...new Set(adopted.map((migration) => migration.source))]
  return {
    count: adopted.length,
    sources,
    badge: `adopted ${adopted.length} earlier rewind marker${adopted.length === 1 ? '' : 's'}`,
  }
}

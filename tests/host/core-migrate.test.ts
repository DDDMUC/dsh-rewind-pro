// Legacy marker migration. Nothing is rewritten: we read the old plugin's
// marker, describe what it meant, and emit ledger ops that reproduce it. The
// scan is always dry-run — the host decides whether to append.

import { describe, expect, it } from 'vitest'
import { scanLegacyMarkers, summarizeMigration } from '../../src/core/migrate'
import { replayOps } from '../../src/core/ledger'

const file = (path: string, content: unknown) => ({ path, content: typeof content === 'string' ? content : JSON.stringify(content) })

describe('scanLegacyMarkers', () => {
  it('ignores files that are not rewind markers', () => {
    expect(scanLegacyMarkers([file('notes.txt', 'hello'), file('package.json', { name: 'x' })])).toEqual([])
  })

  it('reads a range-shaped marker and replays it as a committed rewind', () => {
    const [migration] = scanLegacyMarkers([
      file('.dsh/rewind/state.json', { hiddenRanges: [{ start: 7, end: 12 }], strategy: 'derive-patch' }),
    ])
    expect(migration.ranges).toEqual([{ start: 7, end: 12 }])
    expect(replayOps(migration.ops).ranges).toEqual([{ start: 7, end: 12 }])
  })

  it('tolerates the {from,to} spelling the other plugin uses', () => {
    const [migration] = scanLegacyMarkers([file('.dsh/rewind/state.json', { ranges: [{ from: 4, to: 6 }] })])
    expect(migration.ranges).toEqual([{ start: 4, end: 6 }])
  })

  it('treats surface-shaped markers as irreversible', () => {
    const [migration] = scanLegacyMarkers([file('.dsh/rewind/state.json', { surfaceOps: [{ start: 3, end: 9 }] })])
    expect(migration.source).toBe('sirilee')
    expect(migration.ops.some((op) => op.kind === 'commit' && op.strategy === 'surface-op')).toBe(true)
  })

  it('never throws on garbage: it warns and moves on', () => {
    const migrations = scanLegacyMarkers([file('.dsh/rewind/state.json', '{not json')])
    expect(migrations[0].ranges).toEqual([])
    expect(migrations[0].warnings.join(' ')).toMatch(/unreadable|parse/i)
  })

  it('skips markers it cannot make sense of', () => {
    expect(scanLegacyMarkers([file('.dsh/rewind/state.json', { unrelated: 1 })])).toEqual([])
  })
})

describe('summarizeMigration', () => {
  it('stays silent when there is nothing to migrate', () => {
    expect(summarizeMigration([])).toEqual({ count: 0, sources: [], badge: null })
  })

  it('produces a quiet badge when old markers were adopted', () => {
    const [migration] = scanLegacyMarkers([file('.dsh/rewind/state.json', { hiddenRanges: [{ start: 7, end: 12 }] })])
    const summary = summarizeMigration([migration])
    expect(summary.count).toBe(1)
    expect(summary.badge).toMatch(/1/)
  })
})

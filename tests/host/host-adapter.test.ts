// The adapter is the only place the host's real contract is spelled out.
// Two things it must get exactly right, both learned the hard way:
//   * the surface fold emits the host's CURRENT SurfaceOp spelling
//     ({op:'replace', startSeq, endSeq}). The {start,end} shape this plugin was
//     originally written against is no longer accepted by Session.append.
//   * optional services are read through ctx.get(name, false), which needs no
//     inject declaration — cordis 4 THROWS on a plain property read instead.

import { describe, expect, it } from 'vitest'
import { detectAdapter, sessionToMessages } from '../../src/host/adapter'
import type { SurfaceOp } from '../../src/core/strategy-surface'

const sessionEvents = [
  { type: 'user/message', seq: 1, data: { content: 'write a parser' } },
  { type: 'assistant/message', seq: 2, data: { message: { content: 'sure' }, turn: 1, step: 1 } },
  { type: 'user/message', seq: 3, data: { content: 'now add tests' } },
  { type: 'assistant/message', seq: 4, data: { message: { content: 'ok' }, turn: 1, step: 1 } },
]

interface AppendRecord {
  type: unknown
  data: unknown
  opts: Record<string, unknown>
}

const makeSession = (appends: AppendRecord[]) => ({
  id: 'session-1',
  seq: 5,
  firstLiveSeq: 0,
  surface: { replaceGeneration: 0 },
  snapshotEvents: () => [...sessionEvents],
  append: (type: unknown, data: unknown, opts: Record<string, unknown>) => {
    appends.push({ type, data, opts })
    return { seq: 5 }
  },
})

describe('sessionToMessages', () => {
  it('maps user/assistant turns into the core message view', () => {
    const messages = sessionToMessages(makeSession([]))
    expect(messages.map((m) => [m.seq, m.role, m.text])).toEqual([
      [1, 'user', 'write a parser'],
      [2, 'assistant', 'sure'],
      [3, 'user', 'now add tests'],
      [4, 'assistant', 'ok'],
    ])
  })
})

describe('surface fold payload', () => {
  it('emits startSeq/endSeq and never the retired start/end spelling', async () => {
    const appends: AppendRecord[] = []
    const session = makeSession(appends)
    const probe = detectAdapter({ sessions: { list: () => [session], get: () => session } })

    const op: SurfaceOp = {
      type: 'replace',
      range: { start: 3, end: 4 },
      message: { role: 'system', text: 'hidden' },
    }
    await expect(probe.adapter.appendSurfaceOp(op)).resolves.toBe(true)

    expect(appends).toHaveLength(1)
    expect(appends[0].opts.surfaceOp).toEqual({ op: 'replace', startSeq: 3, endSeq: 4 })
    expect('start' in (appends[0].opts.surfaceOp as object)).toBe(false)
    expect(appends[0].opts.sourceEventSeqs).toEqual([3, 4])
  })
})

describe('service reads', () => {
  it('reads the harness version through ctx.get without an inject declaration', () => {
    const ctx = {
      get: (name: string) => (name === 'dsh' ? { version: '0.2.0-rc.2' } : undefined),
      sessions: { list: () => [] },
    }
    expect(detectAdapter(ctx).adapter.dshVersion()).toBe('0.2.0-rc.2')
  })

  it('degrades to a null adapter when the sessions service is absent', () => {
    const probe = detectAdapter({})
    expect(probe.bound).toBe(false)
    expect(probe.notes.join(' ')).toContain('ctx.sessions unavailable')
    expect(probe.adapter.canAppendSurfaceOp()).toBe(false)
  })

  it('registers commands on the commands service and reports when there is none', () => {
    const registered: Array<{ name: string; description: string }> = []
    const ctx = {
      sessions: { list: () => [makeSession([])], get: () => makeSession([]) },
      get: (name: string) =>
        name === 'commands'
          ? {
              register: (definition: { name: string; description: string }) => {
                registered.push(definition)
                return () => undefined
              },
            }
          : undefined,
    }
    const probe = detectAdapter(ctx)
    probe.adapter.registerCommand({ name: 'rewind', description: 'list targets', handler: async () => 'ok' })
    expect(registered.map((d) => d.name)).toEqual(['rewind'])

    const bare = detectAdapter({ sessions: { list: () => [], get: () => undefined } })
    bare.adapter.registerCommand({ name: 'rewind', description: 'list targets', handler: async () => 'ok' })
    expect(bare.notes.join(' ')).toContain('no command registry')
  })
})

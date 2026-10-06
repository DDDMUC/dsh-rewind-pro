// Client contract: one API prefix, one SSE endpoint, same-origin.
// There is no __DSH_API_BASE__ in this harness, so the prefix is a constant
// that the profile config may override — nothing else.

import { describe, expect, it } from 'vitest'
import { apiPath, API_PREFIX, eventsPath, parseSseChunk } from '../../src/client/contract'

describe('apiPath', () => {
  it('builds same-origin URLs under the plugin prefix', () => {
    expect(apiPath('/state', { sessionId: 's1' })).toBe('/api/dsh-rewind-pro/state?sessionId=s1')
  })

  it('honours a configured prefix (subpath deployments)', () => {
    expect(apiPath('/state', { sessionId: 's1' }, '/custom/rewind')).toBe('/custom/rewind/state?sessionId=s1')
  })

  it('encodes session ids so a weird id cannot forge a path', () => {
    expect(apiPath('/state', { sessionId: 'a/b?c' })).not.toContain('a/b')
  })

  it('exposes the SSE endpoint separately', () => {
    expect(eventsPath('s1')).toContain('/events')
    expect(eventsPath('s1')).toContain('sessionId=s1')
  })

  it('keeps the default prefix the documented one', () => {
    expect(API_PREFIX).toBe('/api/dsh-rewind-pro')
  })
})

describe('parseSseChunk', () => {
  it('reads an event/data pair', () => {
    const parsed = parseSseChunk('event: state\ndata: {"version":3}\n\n')
    expect(parsed).toEqual([{ event: 'state', data: { version: 3 } }])
  })

  it('reads two events that arrived in one chunk', () => {
    const parsed = parseSseChunk('event: state\ndata: {"version":1}\n\nevent: state\ndata: {"version":2}\n\n')
    expect(parsed.map((p) => (p.data as { version: number }).version)).toEqual([1, 2])
  })

  it('ignores heartbeats and junk instead of throwing', () => {
    expect(parseSseChunk(': ping\n\n')).toEqual([])
    expect(parseSseChunk('data: not json\n\n')).toEqual([])
  })
})

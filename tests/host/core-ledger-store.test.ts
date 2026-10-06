// Ledger persistence: append-only, atomic, monotonic version, and safe against
// a crash mid-write. Concurrent appends to one session must serialize or we
// can lose an op.

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLedgerStore, sanitizeSessionId } from '../../src/core/ledger-store'
import type { LedgerOp } from '../../src/core/types'

const dirs: string[] = []
const tmp = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rewind-ledger-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))))
})

const mark = (opId: string): LedgerOp => ({ kind: 'mark', opId, targetSeq: 5, strategy: 'derive-patch', time: 1, epoch: 'e1' })

describe('sanitizeSessionId', () => {
  it('strips path traversal and separators', () => {
    const cleaned = sanitizeSessionId('../../etc/passwd')
    expect(cleaned).not.toMatch(/[\\/]/)
    expect(cleaned).not.toContain('..')
    expect(sanitizeSessionId('a/b\\c')).toBe('a_b_c')
    expect(sanitizeSessionId('safe-id.1')).toBe('safe-id.1')
  })
})

describe('ledger store', () => {
  it('starts empty when nothing was written yet', async () => {
    const store = createLedgerStore({ dir: await tmp(), sessionId: 's1' })
    expect(await store.read()).toEqual({ version: 0, ops: [] })
  })

  it('appends ops and bumps the version monotonically', async () => {
    const store = createLedgerStore({ dir: await tmp(), sessionId: 's1' })
    const first = await store.append(mark('m1'), 'tab-a')
    const second = await store.append(mark('m2'), 'tab-a')
    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(second.ops).toHaveLength(2)
    expect(second.originClientId).toBe('tab-a')
  })

  it('serializes concurrent appends so no op is lost', async () => {
    const store = createLedgerStore({ dir: await tmp(), sessionId: 's1' })
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append(mark(`m${i}`))))
    const state = await store.read()
    expect(state.ops).toHaveLength(20)
    expect(state.version).toBe(20)
    expect(new Set(state.ops.map((op) => op.opId)).size).toBe(20)
  })

  it('writes atomically: the ledger file is never a half-written JSON', async () => {
    const dir = await tmp()
    const store = createLedgerStore({ dir, sessionId: 's1' })
    await store.append(mark('m1'))
    for (let i = 0; i < 5; i++) await store.append(mark(`more-${i}`))
    const raw = await readFile(path.join(dir, 's1.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(JSON.parse(raw).ops).toHaveLength(6)
    const files = await readdir(dir)
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('survives a corrupt ledger without losing the session', async () => {
    const dir = await tmp()
    await writeFile(path.join(dir, 's1.json'), '{ half written', 'utf8')
    const store = createLedgerStore({ dir, sessionId: 's1' })
    expect(await store.read()).toEqual({ version: 0, ops: [] })
    const files = await readdir(dir)
    expect(files.some((f) => f.includes('corrupt'))).toBe(true)
  })

  it('ignores a remote state that is not strictly newer', async () => {
    const store = createLedgerStore({ dir: await tmp(), sessionId: 's1' })
    const local = await store.append(mark('m1'), 'tab-a')
    const merged = await store.mergeRemote({ version: local.version, ops: [] }, 'tab-b')
    expect(merged.ops).toHaveLength(1)
  })

  it('drops an echo of its own write', async () => {
    const store = createLedgerStore({ dir: await tmp(), sessionId: 's1' })
    await store.append(mark('m1'), 'tab-a')
    const merged = await store.mergeRemote({ version: 99, originClientId: 'tab-a', ops: [] }, 'tab-a')
    expect(merged.version).toBe(1)
    expect(merged.ops.map((op) => op.opId)).toEqual(['m1'])
  })

  it('adopts a strictly newer remote state', async () => {
    const store = createLedgerStore({ dir: await tmp(), sessionId: 's1' })
    await store.append(mark('m1'), 'tab-a')
    const merged = await store.mergeRemote({ version: 5, ops: [mark('m9')] }, 'tab-b')
    expect(merged.version).toBe(5)
    expect((await store.read()).ops.map((op) => op.opId)).toEqual(['m9'])
  })
})

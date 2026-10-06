// Capture: back a file up BEFORE the write lands, not after. Subagent edits
// count too, and a file already captured in this anchor must not be captured
// twice (or a long turn would multiply storage for nothing).

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureBeforeWrite } from '../../src/snapshot/capture'
import { createSnapshotStore } from '../../src/snapshot/store'
import { cleanupTmp, tmpDir, writeFile as putFile } from './helpers/tmp'

afterAll(cleanupTmp)

const base = { sessionId: 's1', anchorKey: 'turn-4', maxFileBytes: 1024 * 1024 }

describe('captureBeforeWrite', () => {
  it('keeps the content as it was before the write', async () => {
    const root = await tmpDir('capture-')
    const store = createSnapshotStore(root)
    const abs = await putFile(root, 'src/a.ts', 'version one')

    await captureBeforeWrite(store, { ...base, root, absPath: abs })
    await writeFile(abs, 'version two', 'utf8')

    const anchor = await store.readAnchor('s1', 'turn-4')
    expect(anchor?.files).toHaveLength(1)
    expect(await store.readBlob('s1', anchor!.files[0].sha256)).toEqual(Buffer.from('version one'))
  })

  it('captures a file only once per anchor', async () => {
    const root = await tmpDir('capture-')
    const store = createSnapshotStore(root)
    const abs = await putFile(root, 'src/a.ts', 'v1')

    await captureBeforeWrite(store, { ...base, root, absPath: abs })
    await writeFile(abs, 'v2', 'utf8')
    const second = await captureBeforeWrite(store, { ...base, root, absPath: abs })

    expect(second).toMatchObject({ captured: false, reason: 'already-captured' })
    expect((await store.readAnchor('s1', 'turn-4'))?.files).toHaveLength(1)
  })

  it('skips files the guard refuses, saying why', async () => {
    const root = await tmpDir('capture-')
    const store = createSnapshotStore(root)
    const abs = await putFile(root, 'node_modules/pkg/index.js', 'x')

    const result = await captureBeforeWrite(store, { ...base, root, absPath: abs })
    expect(result).toMatchObject({ captured: false, reason: 'ignored' })
    expect((await store.readAnchor('s1', 'turn-4'))?.files ?? []).toHaveLength(0)
  })

  it('refuses files above the size cap', async () => {
    const root = await tmpDir('capture-')
    const store = createSnapshotStore(root)
    const abs = await putFile(root, 'big.txt', 'x'.repeat(5000))

    const result = await captureBeforeWrite(store, { ...base, root, absPath: abs, maxFileBytes: 100 })
    expect(result).toMatchObject({ captured: false, reason: 'too-large' })
  })

  it('records which agent made the edit (subagent tracking)', async () => {
    const root = await tmpDir('capture-')
    const store = createSnapshotStore(root)
    const abs = await putFile(root, 'src/a.ts', 'v1')

    await captureBeforeWrite(store, { ...base, root, absPath: abs, agentId: 'sub-7' })
    const anchor = await store.readAnchor('s1', 'turn-4')
    expect(anchor?.files[0].agentId).toBe('sub-7')
  })

  it('stores paths relative to the workspace root', async () => {
    const root = await tmpDir('capture-')
    const store = createSnapshotStore(root)
    const abs = await putFile(root, 'src/nested/a.ts', 'v1')

    await captureBeforeWrite(store, { ...base, root, absPath: abs })
    const anchor = await store.readAnchor('s1', 'turn-4')
    expect(anchor?.files[0].path).toBe(path.join('src', 'nested', 'a.ts').replace(/\\/g, '/'))
  })
})

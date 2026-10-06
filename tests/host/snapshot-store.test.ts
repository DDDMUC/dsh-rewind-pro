// Snapshot store: content-addressed blobs per anchor, deduplicated, pruned to
// a bounded number of anchors, and serialized per session so a reconcile can
// never read a half-written index.

import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createSnapshotStore } from '../../src/snapshot/store'
import type { Anchor } from '../../src/snapshot/store'
import { cleanupTmp, tmpDir } from './helpers/tmp'

afterAll(cleanupTmp)

const anchor = (key: string, files: Anchor['files'], createdAt = 1): Anchor => ({
  key,
  sessionId: 's1',
  createdAt,
  files,
})

describe('snapshot store', () => {
  it('round-trips an anchor index', async () => {
    const store = createSnapshotStore(await tmpDir('snap-'))
    await store.writeAnchor(anchor('turn-3', [{ path: 'src/a.ts', sha256: 'aaa', size: 3, mtimeMs: 1 }]))
    const read = await store.readAnchor('s1', 'turn-3')
    expect(read?.files[0].path).toBe('src/a.ts')
  })

  it('stores identical content once no matter how many paths use it', async () => {
    const root = await tmpDir('snap-')
    const store = createSnapshotStore(root)
    await store.writeBlob('s1', 'same', Buffer.from('hello'))
    await store.writeBlob('s1', 'same', Buffer.from('hello'))
    await store.writeBlob('s1', 'other', Buffer.from('world'))
    const blobs = await listBlobs(root, 's1')
    expect(blobs).toHaveLength(2)
    expect(await store.readBlob('s1', 'same')).toEqual(Buffer.from('hello'))
  })

  it('lists anchors oldest first', async () => {
    const store = createSnapshotStore(await tmpDir('snap-'))
    await store.writeAnchor(anchor('a', [], 3))
    await store.writeAnchor(anchor('b', [], 1))
    await store.writeAnchor(anchor('c', [], 2))
    const keys = (await store.listAnchors('s1')).map((a) => a.key)
    expect(keys).toEqual(['b', 'c', 'a'])
  })

  it('prunes to the newest anchors and keeps blobs still referenced', async () => {
    const root = await tmpDir('snap-')
    const store = createSnapshotStore(root)
    await store.writeBlob('s1', 'shared', Buffer.from('shared'))
    await store.writeBlob('s1', 'old-only', Buffer.from('old'))
    await store.writeAnchor(anchor('old', [{ path: 'a', sha256: 'shared', size: 1, mtimeMs: 1 }, { path: 'b', sha256: 'old-only', size: 1, mtimeMs: 1 }], 1))
    await store.writeAnchor(anchor('new', [{ path: 'a', sha256: 'shared', size: 1, mtimeMs: 1 }], 2))

    const pruned = await store.pruneAnchors('s1', 1)
    expect(pruned).toBe(1)
    expect((await store.listAnchors('s1')).map((a) => a.key)).toEqual(['new'])
    const blobs = await listBlobs(root, 's1')
    expect(blobs).toContain('shared')
    expect(blobs).not.toContain('old-only')
  })

  it('serializes concurrent anchor updates so no file entry is lost', async () => {
    const store = createSnapshotStore(await tmpDir('snap-'))
    await store.writeAnchor(anchor('turn-9', []))
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        store.addFile('s1', 'turn-9', { path: `f${i}.ts`, sha256: `h${i}`, size: i, mtimeMs: i }),
      ),
    )
    const read = await store.readAnchor('s1', 'turn-9')
    expect(read?.files).toHaveLength(15)
    expect(new Set(read?.files.map((f) => f.path)).size).toBe(15)
  })

  it('writes anchors atomically: no leftover temp files', async () => {
    const root = await tmpDir('snap-')
    const store = createSnapshotStore(root)
    for (let i = 0; i < 5; i++) await store.writeAnchor(anchor(`k${i}`, [{ path: `p${i}`, sha256: 'x', size: 1, mtimeMs: 1 }], i))
    const anchorDir = path.join(root, 'sessions', 's1', 'anchors')
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(anchorDir)
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(files).toHaveLength(5)
  })

  it('keeps sessions isolated', async () => {
    const store = createSnapshotStore(await tmpDir('snap-'))
    await store.writeAnchor({ ...anchor('turn-1', [{ path: 'a', sha256: 'x', size: 1, mtimeMs: 1 }]), sessionId: 's1' })
    await store.writeAnchor({ ...anchor('turn-1', [{ path: 'b', sha256: 'y', size: 1, mtimeMs: 1 }]), sessionId: 's2' })
    expect((await store.readAnchor('s1', 'turn-1'))?.files[0].path).toBe('a')
    expect((await store.readAnchor('s2', 'turn-1'))?.files[0].path).toBe('b')
  })
})

async function listBlobs(root: string, sessionId: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    return await readdir(path.join(root, 'sessions', sessionId, 'blobs'))
  } catch {
    return []
  }
}

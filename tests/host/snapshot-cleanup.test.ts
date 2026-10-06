// Cleanup: bound what the plugin keeps, and never prune a blob a surviving
// anchor still needs.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupSession } from '../../src/snapshot/cleanup'
import { createSnapshotStore } from '../../src/snapshot/store'
import { cleanupTmp, tmpDir } from './helpers/tmp'

afterAll(cleanupTmp)

describe('cleanupSession', () => {
  it('prunes anchors past the retention limit', async () => {
    const store = createSnapshotStore(await tmpDir('cleanup-'))
    for (let i = 0; i < 5; i++) {
      await store.writeAnchor({ key: `turn-${i}`, sessionId: 's1', createdAt: i, files: [] })
    }
    const report = await cleanupSession(store, 's1', { maxAnchorGroups: 2, rescueRetention: 3 })
    expect(report.anchorsPruned).toBe(3)
    expect((await store.listAnchors('s1')).map((a) => a.key)).toEqual(['turn-3', 'turn-4'])
  })

  it('keeps the newest rescue directories and drops the rest', async () => {
    const root = await tmpDir('cleanup-')
    const store = createSnapshotStore(root)
    const rescueRoot = path.join(root, 'sessions', 's1', 'rescue')
    for (let i = 0; i < 4; i++) {
      await mkdir(path.join(rescueRoot, `r${i}`), { recursive: true })
      await writeFile(path.join(rescueRoot, `r${i}`, 'a.txt'), `v${i}`)
    }
    const { utimes } = await import('node:fs/promises')
    for (let i = 0; i < 4; i++) await utimes(path.join(rescueRoot, `r${i}`), new Date(i), new Date(i))

    const report = await cleanupSession(store, 's1', { maxAnchorGroups: 10, rescueRetention: 2 })
    expect(report.rescuesPruned).toBe(2)
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(rescueRoot)).sort()).toEqual(['r2', 'r3'])
  })

  it('does nothing when the session has no data', async () => {
    const store = createSnapshotStore(await tmpDir('cleanup-'))
    const report = await cleanupSession(store, 'ghost', { maxAnchorGroups: 5, rescueRetention: 5 })
    expect(report).toEqual({ anchorsPruned: 0, rescuesPruned: 0 })
  })
})

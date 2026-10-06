// Cleanup: bound the disk a rewind plugin is allowed to use.
//
// Anchors are pruned to the newest N (blobs still referenced by a surviving
// anchor are kept), and rescue directories are pruned to the newest N so "you
// can always get your files back" does not turn into unbounded growth.

import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { SnapshotStore } from './store.js'

export interface CleanupOptions {
  maxAnchorGroups: number
  rescueRetention: number
}

export interface CleanupReport {
  anchorsPruned: number
  rescuesPruned: number
}

export async function cleanupSession(
  store: SnapshotStore,
  sessionId: string,
  options: CleanupOptions,
): Promise<CleanupReport> {
  const anchorsPruned = await store.pruneAnchors(sessionId, options.maxAnchorGroups)

  const rescueRoot = path.join(store.root, 'sessions', sessionId, 'rescue')
  let rescuesPruned = 0
  let entries: string[] = []
  try {
    entries = await readdir(rescueRoot)
  } catch {
    return { anchorsPruned, rescuesPruned: 0 }
  }

  const withTime = await Promise.all(
    entries.map(async (name) => {
      try {
        const info = await stat(path.join(rescueRoot, name))
        return { name, mtimeMs: info.mtimeMs }
      } catch {
        return { name, mtimeMs: 0 }
      }
    }),
  )

  withTime.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const entry of withTime.slice(options.rescueRetention)) {
    await rm(path.join(rescueRoot, entry.name), { recursive: true, force: true })
    rescuesPruned++
  }

  return { anchorsPruned, rescuesPruned }
}

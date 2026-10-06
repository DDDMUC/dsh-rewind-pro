// Snapshot storage layout:
//   <root>/sessions/<sessionId>/anchors/<anchorKey>.json   (atomic)
//   <root>/sessions/<sessionId>/blobs/<sha256>             (content-addressed)
//
// Blobs are content-addressed so identical content is stored once no matter
// how many paths or turns share it. Every mutation goes through a per-session
// queue: a reconcile must never observe a half-written index.

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sanitizeSessionId } from '../core/ledger-store.js'

export interface FileEntry {
  /** Path relative to the workspace root, always with forward slashes. */
  path: string
  sha256: string
  size: number
  mtimeMs: number
  /** Set when the write came from a subagent session. */
  agentId?: string
}

export interface Anchor {
  key: string
  sessionId: string
  createdAt: number
  files: FileEntry[]
}

export interface SnapshotStore {
  root: string
  writeAnchor: (anchor: Anchor) => Promise<void>
  readAnchor: (sessionId: string, key: string) => Promise<Anchor | null>
  listAnchors: (sessionId: string) => Promise<Anchor[]>
  addFile: (sessionId: string, key: string, entry: FileEntry) => Promise<Anchor>
  writeBlob: (sessionId: string, sha256: string, data: Buffer) => Promise<void>
  readBlob: (sessionId: string, sha256: string) => Promise<Buffer>
  hasBlob: (sessionId: string, sha256: string) => Promise<boolean>
  pruneAnchors: (sessionId: string, keep: number) => Promise<number>
  rescueDir: (sessionId: string, restoreId: string) => string
}

const safeKey = (key: string): string => sanitizeSessionId(key)

/** Serialize per key so concurrent callers cannot interleave read-modify-write. */
function createSerialQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    tails.set(
      key,
      next.catch(() => undefined),
    )
    return next
  }
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(tmp, data)
  await rename(tmp, file)
}

export function createSnapshotStore(root: string): SnapshotStore {
  const enqueue = createSerialQueue()

  const sessionRoot = (sessionId: string) => path.join(root, 'sessions', safeKey(sessionId))
  const anchorDir = (sessionId: string) => path.join(sessionRoot(sessionId), 'anchors')
  const blobDir = (sessionId: string) => path.join(sessionRoot(sessionId), 'blobs')
  const anchorFile = (sessionId: string, key: string) => path.join(anchorDir(sessionId), `${safeKey(key)}.json`)
  const blobFile = (sessionId: string, sha256: string) => path.join(blobDir(sessionId), sha256)

  const readAnchorUnlocked = async (sessionId: string, key: string): Promise<Anchor | null> => {
    try {
      const raw = await readFile(anchorFile(sessionId, key), 'utf8')
      const parsed = JSON.parse(raw) as Anchor
      if (!parsed || !Array.isArray(parsed.files)) return null
      return parsed
    } catch {
      return null
    }
  }

  const readAnchor = (sessionId: string, key: string): Promise<Anchor | null> =>
    enqueue(`${sessionId}:${key}`, () => readAnchorUnlocked(sessionId, key))

  return {
    root,

    writeAnchor: (anchor) =>
      enqueue(`${anchor.sessionId}:${anchor.key}`, async () => {
        await writeAtomic(anchorFile(anchor.sessionId, anchor.key), `${JSON.stringify(anchor, null, 2)}\n`)
      }),

    readAnchor,

    listAnchors: async (sessionId) => {
      let names: string[]
      try {
        names = await readdir(anchorDir(sessionId))
      } catch {
        return []
      }
      const anchors: Anchor[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const anchor = await readAnchor(sessionId, name.replace(/\.json$/, ''))
        if (anchor) anchors.push(anchor)
      }
      return anchors.sort((a, b) => a.createdAt - b.createdAt)
    },

    addFile: (sessionId, key, entry) =>
      enqueue(`${sessionId}:${key}`, async () => {
        const current = (await readAnchorUnlocked(sessionId, key)) ?? {
          key,
          sessionId,
          createdAt: Date.now(),
          files: [],
        }
        const files = current.files.some((file) => file.path === entry.path)
          ? current.files
          : [...current.files, entry]
        const next: Anchor = { ...current, files }
        await writeAtomic(anchorFile(sessionId, key), `${JSON.stringify(next, null, 2)}\n`)
        return next
      }),

    writeBlob: async (sessionId, sha256, data) => {
      const file = blobFile(sessionId, sha256)
      // Content-addressed: if the blob exists the content is already identical.
      try {
        await readFile(file)
        return
      } catch {
        /* not there yet */
      }
      await writeAtomic(file, data)
    },

    readBlob: (sessionId, sha256) => readFile(blobFile(sessionId, sha256)),

    hasBlob: async (sessionId, sha256) => {
      try {
        await readFile(blobFile(sessionId, sha256))
        return true
      } catch {
        return false
      }
    },

    pruneAnchors: (sessionId, keep) =>
      enqueue(`${sessionId}:prune`, async () => {
        const anchors = await (async () => {
          let names: string[]
          try {
            names = await readdir(anchorDir(sessionId))
          } catch {
            return [] as Anchor[]
          }
          const out: Anchor[] = []
          for (const name of names) {
            if (!name.endsWith('.json')) continue
            const anchor = await readAnchorUnlocked(sessionId, name.replace(/\.json$/, ''))
            if (anchor) out.push(anchor)
          }
          return out.sort((a, b) => a.createdAt - b.createdAt)
        })()

        if (anchors.length <= keep) return 0
        const doomed = anchors.slice(0, anchors.length - keep)
        const survivors = anchors.slice(anchors.length - keep)
        const referenced = new Set(survivors.flatMap((anchor) => anchor.files.map((file) => file.sha256)))

        for (const anchor of doomed) {
          await rm(anchorFile(sessionId, anchor.key), { force: true })
          for (const file of anchor.files) {
            // A blob shared with a surviving anchor must stay: dropping it
            // would silently corrupt the restore of that anchor.
            if (referenced.has(file.sha256)) continue
            await rm(blobFile(sessionId, file.sha256), { force: true })
          }
        }
        return doomed.length
      }),

    rescueDir: (sessionId, restoreId) =>
      path.join(sessionRoot(sessionId), 'rescue', safeKey(restoreId)),
  }
}

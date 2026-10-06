// Capture: copy a file into the current anchor BEFORE the write lands.
//
// Called from the write-tool hook: at that moment the file on disk still holds
// the pre-write content, which is exactly what a rewind needs. Subagent edits
// are tagged with their agent id so a rewind can account for them too.

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { sha256, trackPath } from './guard.js'
import type { SnapshotStore } from './store.js'

export interface CaptureRequest {
  sessionId: string
  /** Anchor key: usually the turn/message seq the write belongs to. */
  anchorKey: string
  /** Workspace root; stored paths are relative to it. */
  root: string
  absPath: string
  agentId?: string
  maxFileBytes: number
  ignore?: string[]
}

export type CaptureResult =
  | { captured: true; sha256: string; size: number; path: string }
  | { captured: false; reason: string }

const toPosix = (value: string): string => value.split(path.sep).join('/')

export async function captureBeforeWrite(store: SnapshotStore, request: CaptureRequest): Promise<CaptureResult> {
  const decision = await trackPath(
    { root: request.root, maxFileBytes: request.maxFileBytes, ignore: request.ignore },
    request.absPath,
  )
  if (!decision.track) return { captured: false, reason: decision.reason }

  const relPath = toPosix(path.relative(request.root, request.absPath))

  const existing = await store.readAnchor(request.sessionId, request.anchorKey)
  if (existing?.files.some((file) => file.path === relPath)) {
    // Already backed up in this anchor: the first capture is the one that
    // matters for rewind, and re-capturing would only burn disk.
    return { captured: false, reason: 'already-captured' }
  }

  let data: Buffer
  try {
    data = await readFile(request.absPath)
  } catch {
    return { captured: false, reason: 'unreadable' }
  }
  if (data.byteLength > request.maxFileBytes) return { captured: false, reason: 'too-large' }

  const hash = sha256(data)
  let mtimeMs = 0
  try {
    mtimeMs = (await stat(request.absPath)).mtimeMs
  } catch {
    mtimeMs = 0
  }

  await store.writeBlob(request.sessionId, hash, data)
  await store.addFile(request.sessionId, request.anchorKey, {
    path: relPath,
    sha256: hash,
    size: data.byteLength,
    mtimeMs,
    ...(request.agentId ? { agentId: request.agentId } : {}),
  })

  return { captured: true, sha256: hash, size: data.byteLength, path: relPath }
}

// Rescue: a rewind never deletes. Files that would be overwritten or removed
// are moved into a rescue directory first, so a rewind that turns out to be the
// wrong call is recoverable.
//
// rename() is the fast path but fails with EXDEV across volumes, so we fall
// back to copy -> verify -> unlink. Cross-volume copies are bounded by
// maxFileBytes: a rescue must never be the thing that fills the disk.

import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export interface RescueIo {
  rename: (from: string, to: string) => Promise<unknown>
  copyFile: (from: string, to: string) => Promise<unknown>
  unlink: (from: string) => Promise<unknown>
  stat: (from: string) => Promise<{ size: number; mtimeMs: number }>
  mkdir: (dir: string) => Promise<unknown>
}

export interface RescueOptions {
  maxFileBytes: number
  io?: RescueIo
  /**
   * Where the file sits inside the rescue dir. Defaults to the basename, but
   * callers pass the workspace-relative path so the rescue tree mirrors the
   * workspace and same-named files from different folders stay distinguishable.
   */
  relative?: string
}

export type RescueResult =
  | { ok: true; via: 'rename' | 'copy'; target: string; size: number }
  | { ok: false; reason: 'missing' | 'too-large' | 'failed'; detail?: string }

const nodeIo: RescueIo = {
  rename: (from, to) => rename(from, to),
  copyFile: (from, to) => copyFile(from, to),
  unlink: (from) => rm(from, { force: true }),
  stat: (from) => stat(from),
  mkdir: (dir) => mkdir(dir, { recursive: true }),
}

const exists = async (io: RescueIo, target: string): Promise<boolean> => {
  try {
    await io.stat(target)
    return true
  } catch {
    return false
  }
}

/** `a.txt` -> `a.txt`, then `a-1.txt`, `a-2.txt` ... never overwrite a rescue. */
export async function freeTarget(io: RescueIo, base: string): Promise<string> {
  if (!(await exists(io, base))) return base
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!(await exists(io, candidate))) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

export async function moveToRescue(from: string, rescueDir: string, options: RescueOptions): Promise<RescueResult> {
  const io = options.io ?? nodeIo

  let size: number
  try {
    size = (await io.stat(from)).size
  } catch {
    return { ok: false, reason: 'missing' }
  }

  const relative = (options.relative ?? path.basename(from)).split('/').join(path.sep)
  const target = await freeTarget(io, path.join(rescueDir, relative))
  await io.mkdir(path.dirname(target))

  try {
    await io.rename(from, target)
    return { ok: true, via: 'rename', target, size }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== 'EXDEV') return { ok: false, reason: 'failed', detail: String(error) }

    if (size > options.maxFileBytes) return { ok: false, reason: 'too-large' }
    try {
      await io.copyFile(from, target)
      const copied = await io.stat(target)
      // Verify before destroying the source: a short copy would be data loss.
      if (copied.size !== size) {
        await io.unlink(target).catch(() => undefined)
        return { ok: false, reason: 'failed', detail: 'copy size mismatch' }
      }
      await io.unlink(from)
      return { ok: true, via: 'copy', target, size }
    } catch (copyError) {
      return { ok: false, reason: 'failed', detail: String(copyError) }
    }
  }
}

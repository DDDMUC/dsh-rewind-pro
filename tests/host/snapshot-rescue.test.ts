// Rescue: never hard-delete a file a rewind overwrites. Move it aside first,
// and when the move cannot happen (different volume: EXDEV), fall back to
// copy-then-verify-then-unlink. A name collision must not lose data either.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { moveToRescue } from '../../src/snapshot/rescue'
import type { RescueIo, RescueResult } from '../../src/snapshot/rescue'

/** Narrow a union in tests: fail loudly instead of asserting on a ghost field. */
function expectOk(result: RescueResult): Extract<RescueResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected rescue to succeed, got ${result.reason}`)
  return result
}
import { cleanupTmp, tmpDir } from './helpers/tmp'

afterAll(cleanupTmp)

const realIo: RescueIo = {
  rename: (from, to) => import('node:fs/promises').then((fs) => fs.rename(from, to)),
  copyFile: (from, to) => import('node:fs/promises').then((fs) => fs.copyFile(from, to)),
  unlink: (from) => import('node:fs/promises').then((fs) => fs.rm(from, { force: true })),
  stat: (from) => import('node:fs/promises').then((fs) => fs.stat(from)),
  mkdir: (dir) => import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true })),
}

describe('moveToRescue', () => {
  it('moves the file and reports where it went', async () => {
    const root = await tmpDir('rescue-')
    const file = path.join(root, 'a.txt')
    await writeFile(file, 'current')
    const rescueDir = path.join(root, 'rescue')

    const moved = expectOk(await moveToRescue(file, rescueDir, { maxFileBytes: 1024, io: realIo }))
    expect(moved.via).toBe('rename')
    expect(existsSync(file)).toBe(false)
    expect(await readFile(moved.target, 'utf8')).toBe('current')
  })

  it('falls back to copy+verify+unlink across volumes (EXDEV)', async () => {
    const root = await tmpDir('rescue-')
    const file = path.join(root, 'a.txt')
    await writeFile(file, 'current')
    let unlinked = false
    const io: RescueIo = {
      ...realIo,
      rename: async () => {
        const error = new Error('cross-device link not permitted') as NodeJS.ErrnoException
        error.code = 'EXDEV'
        throw error
      },
      unlink: async (from) => {
        unlinked = true
        return realIo.unlink(from)
      },
    }

    const moved = expectOk(await moveToRescue(file, path.join(root, 'rescue'), { maxFileBytes: 1024, io }))
    expect(moved.via).toBe('copy')
    expect(unlinked).toBe(true)
    expect(await readFile(moved.target, 'utf8')).toBe('current')
  })

  it('refuses a cross-volume copy above the size cap instead of filling the disk', async () => {
    const root = await tmpDir('rescue-')
    const file = path.join(root, 'big.txt')
    await writeFile(file, 'x'.repeat(300))
    const io: RescueIo = {
      ...realIo,
      rename: async () => {
        const error = new Error('EXDEV') as NodeJS.ErrnoException
        error.code = 'EXDEV'
        throw error
      },
      stat: async () => ({ size: 300, mtimeMs: 0 }) as never,
    }

    const result = await moveToRescue(file, path.join(root, 'rescue'), { maxFileBytes: 100, io })
    expect(result).toMatchObject({ ok: false, reason: 'too-large' })
    expect(existsSync(file)).toBe(true)
  })

  it('keeps both files when the rescue target name is taken', async () => {
    const root = await tmpDir('rescue-')
    const file = path.join(root, 'a.txt')
    await writeFile(file, 'second')
    const rescueDir = path.join(root, 'rescue')
    await mkdir(rescueDir, { recursive: true })
    await writeFile(path.join(rescueDir, 'a.txt'), 'first')

    const moved = expectOk(await moveToRescue(file, rescueDir, { maxFileBytes: 1024, io: realIo }))
    expect(await readFile(path.join(rescueDir, 'a.txt'), 'utf8')).toBe('first')
    expect(await readFile(moved.target, 'utf8')).toBe('second')
    expect(moved.target).not.toBe(path.join(rescueDir, 'a.txt'))
  })

  it('reports a missing source instead of throwing', async () => {
    const root = await tmpDir('rescue-')
    const result = await moveToRescue(path.join(root, 'gone.txt'), path.join(root, 'rescue'), {
      maxFileBytes: 1024,
      io: realIo,
    })
    expect(result).toMatchObject({ ok: false, reason: 'missing' })
  })
})

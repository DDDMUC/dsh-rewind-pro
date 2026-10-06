// Resource guard: a rewind plugin must never try to snapshot the world.
// Ignore build output and VCS internals, refuse huge files (OOM guard), skip
// binaries we cannot diff meaningfully, and never follow a path outside the
// workspace root or a symlink pointing who-knows-where.

import { symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isIgnored, sniffBinary, trackPath, withinRoot } from '../../src/snapshot/guard'
import { cleanupTmp, tmpDir, writeFile as putFile } from './helpers/tmp'

afterAll(cleanupTmp)

describe('isIgnored', () => {
  it('ignores dependency, VCS and build output by default', () => {
    expect(isIgnored('node_modules/pkg/index.js')).toBe(true)
    expect(isIgnored('.git/config')).toBe(true)
    expect(isIgnored('dist/bundle.js')).toBe(true)
    expect(isIgnored('src/index.ts')).toBe(false)
  })

  it('honours extra ignore patterns', () => {
    expect(isIgnored('debug.log', ['*.log'])).toBe(true)
    expect(isIgnored('src/a.ts', ['*.log'])).toBe(false)
  })
})

describe('sniffBinary', () => {
  it('flags NUL bytes in the sample', () => {
    expect(sniffBinary(new Uint8Array([104, 105, 0, 33]))).toBe(true)
    expect(sniffBinary(new Uint8Array([104, 105, 33]))).toBe(false)
  })
})

describe('withinRoot', () => {
  it('rejects paths that escape the workspace', () => {
    expect(withinRoot('/ws', '/ws/src/a.ts')).toBe(true)
    expect(withinRoot('/ws', '/etc/passwd')).toBe(false)
    expect(withinRoot('/ws', '/ws/../secret')).toBe(false)
  })
})

describe('trackPath', () => {
  const base = { maxFileBytes: 1024 }

  it('tracks an ordinary source file', async () => {
    const root = await tmpDir('guard-')
    await putFile(root, 'src/a.ts', 'export const a = 1')
    const decision = await trackPath({ ...base, root }, path.join(root, 'src', 'a.ts'))
    expect(decision.track).toBe(true)
  })

  it('ignores build output', async () => {
    const root = await tmpDir('guard-')
    await putFile(root, 'dist/bundle.js', 'console.log(1)')
    const decision = await trackPath({ ...base, root }, path.join(root, 'dist', 'bundle.js'))
    expect(decision).toMatchObject({ track: false, reason: 'ignored' })
  })

  it('refuses files above the size cap instead of reading them', async () => {
    const root = await tmpDir('guard-')
    await putFile(root, 'big.bin', 'x'.repeat(2048))
    const decision = await trackPath({ ...base, root, maxFileBytes: 512 }, path.join(root, 'big.bin'))
    expect(decision).toMatchObject({ track: false, reason: 'too-large' })
  })

  it('refuses binaries', async () => {
    const root = await tmpDir('guard-')
    const abs = path.join(root, 'blob.bin')
    await writeFile(abs, Buffer.from([1, 2, 0, 4]))
    const decision = await trackPath({ ...base, root }, abs)
    expect(decision).toMatchObject({ track: false, reason: 'binary' })
  })

  it('skips symlinks rather than following them', async () => {
    const root = await tmpDir('guard-')
    const target = await putFile(root, 'real.txt', 'hi')
    const link = path.join(root, 'link.txt')
    await symlink(target, link)
    const decision = await trackPath({ ...base, root }, link)
    expect(decision).toMatchObject({ track: false, reason: 'symlink' })
  })

  it('refuses paths outside the workspace root', async () => {
    const root = await tmpDir('guard-')
    const elsewhere = await tmpDir('guard-elsewhere-')
    const abs = await putFile(elsewhere, 'a.txt', 'nope')
    const decision = await trackPath({ ...base, root }, abs)
    expect(decision).toMatchObject({ track: false, reason: 'outside-root' })
  })

  it('reports a missing file instead of throwing', async () => {
    const root = await tmpDir('guard-')
    const decision = await trackPath({ ...base, root }, path.join(root, 'gone.ts'))
    expect(decision).toMatchObject({ track: false, reason: 'missing' })
  })
})

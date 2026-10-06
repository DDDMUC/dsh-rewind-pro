// Test-only helpers: throwaway workspaces and snapshot roots.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const created: string[] = []

export async function tmpDir(prefix = 'rewind-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

export async function cleanupTmp(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** Create a file (and its parent dirs) with the given content. */
export async function writeFile(dir: string, rel: string, content: string): Promise<string> {
  const { mkdir, writeFile: write } = await import('node:fs/promises')
  const abs = path.join(dir, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await write(abs, content, 'utf8')
  return abs
}

export async function readFile(dir: string, rel: string): Promise<string> {
  const { readFile: read } = await import('node:fs/promises')
  return read(path.join(dir, rel), 'utf8')
}

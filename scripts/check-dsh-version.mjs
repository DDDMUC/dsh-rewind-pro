// Compares the DSH release tuple this plugin pins (package.json
// dsh.compatibility.dshReleases) against the latest published DSH, and warns
// when a new tuple appears that we have not audited yet. Network is
// best-effort: offline runs exit 0 with a note (CI decides policy).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

const known = Object.keys(pkg.dsh?.compatibility?.dshReleases ?? {})
if (known.length === 0) {
  console.error('[check-dsh-version] no dshReleases declared in package.json')
  process.exit(1)
}

let latest
try {
  const res = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  latest = (await res.json()).version
} catch (error) {
  console.log(`[check-dsh-version] offline or registry error (${error?.message ?? error}); known: ${known.join(', ')}`)
  process.exit(0)
}

const base = (v) => v.split('-')[0]
const isKnown = known.some((k) => base(k) === base(latest) || k === latest)
if (isKnown) {
  console.log(`[check-dsh-version] latest DSH ${latest} is within the audited set: ${known.join(', ')}`)
} else {
  console.warn(`[check-dsh-version] NEW DSH release ${latest} is NOT audited. Known: ${known.join(', ')}`)
  console.warn('  -> run compatibility probes and update dshReleases before shipping a peer bump.')
  process.exit(1)
}

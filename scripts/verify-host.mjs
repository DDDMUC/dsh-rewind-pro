// End-to-end verification of the built host half against the REAL harness
// protocol (ctx.sessions / ctx.webServer / session-event firehose), learned
// from @deepseek-ai/dsh-session's published types. Runs lib/index.js over a
// real socket so `npm run check` proves behavior, not just compilation.

import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const work = await mkdtemp(path.join(tmpdir(), 'rewind-verify-'))
const workspace = path.join(work, 'workspace')
await mkdir(workspace, { recursive: true })

const sessionId = 'verify-session'
const turns = [
  { seq: 1, role: 'user', text: 'write a parser' },
  { seq: 2, role: 'assistant', text: 'sure' },
  { seq: 3, role: 'user', text: 'now add tests' },
  { seq: 4, role: 'assistant', text: 'ok' },
]
const events = turns.map((turn) => ({
  type: turn.role === 'user' ? 'user/message' : 'assistant/message',
  seq: turn.seq,
  time: 1,
  data: turn.role === 'user' ? { content: turn.text } : { message: { content: turn.text }, turn: 1, step: 1 },
}))

// --- fake harness shaped like @deepseek-ai/dsh-session -----------------------
let forkCalls = []
let lastAppend = null
const session = {
  id: sessionId,
  seq: 5,
  firstLiveSeq: 0,
  header: { cwd: workspace },
  surface: { nodes: [], replaceGeneration: 0 },
  snapshotEvents: () => [...events],
  append: (type, data, opts) => {
    lastAppend = { type, data, opts }
    return { seq: events.length + 1, type, data }
  },
}
const registered = []
const commandDefs = []
const commandRegistry = {
  register(definition) {
    registered.push(definition.name)
    commandDefs.push(definition)
    return () => undefined
  },
}
const firehose = new Map()
let effectDisposers = 0
let effectUsed = 0
const ctx = {
  // `root` is a cordis CONTEXT on the real host, never a directory: the plugin
  // must not join it into a path.
  root: { toString: () => '[Context]' },
  logger: { info: () => {}, warn: () => {}, error: (m) => console.error(m) },
  sessions: {
    list: () => [session],
    get: (id) => (id === sessionId ? session : undefined),
    fork: (source, boundary) => {
      forkCalls.push(boundary)
      return { ...session, id: `${sessionId}-child-${forkCalls.length}` }
    },
  },
  // Commands live on the `commands` service; `ctx.registerCommand` never existed
  // on the real host ctx, so the harness must not offer it either.
  get(name) {
    return name === 'commands' ? commandRegistry : undefined
  },
  on(event, handler) {
    firehose.set(event, handler)
  },
  // Real cordis contract: the callback receives a CHILD CONTEXT with the service
  // injected — not the service object itself. Both lazy binds arrive this way.
  inject(services, cb) {
    if (services.includes('commands')) {
      cb({ commands: commandRegistry, effect() { return () => undefined } })
    }
    if (services.includes('webServer')) {
      cb({
        webServer: {
          register(route) {
            routes.push(route)
            return () => {
              effectDisposers++
            }
          },
        },
        effect(fn) {
          effectUsed++
          fn()
          return () => undefined
        },
      })
    }
  },
}
const routes = []

const plugin = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
// Real cordis contract: the entry's resolved config is the SECOND apply
// argument. stateDir/workspaceRoot keep this run out of the real DSH home.
plugin.apply(ctx, { workspaceRoot: workspace, stateDir: work })

const route = routes[0]
const base = `http://localhost${''}`
const dispatch = async (method, url, body) => {
  const chunks = []
  const res = {
    status: 0,
    writeHead(status, headers) {
      void headers
      res.status = status
    },
    write: (chunk) => chunks.push(String(chunk)),
    end: (chunk) => {
      if (chunk) chunks.push(String(chunk))
      res.status = res.status || 200
    },
    on() {},
  }
  const req = {
    method,
    url,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(JSON.stringify(body))
      if (event === 'end') setTimeout(() => cb(), 0)
    },
  }
  route.handler(req, res)
  // The handler completes when the response ends; poll instead of guessing
  // at fs latency (first ledger write pays the mkdir bill on Windows).
  for (let i = 0; i < 200 && res.status === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return { status: res.status, text: chunks.join(''), json: () => JSON.parse(chunks.join('')) }
}

console.log('verify-host: dsh-rewind-pro end-to-end (real protocol shapes)')

// --- route + health + capability --------------------------------------------
check('one prefix route registered', routes.length === 1 && route.kind === 'prefix' && route.path === '/api/dsh-rewind-pro')

const health = await dispatch('GET', '/api/dsh-rewind-pro/health?sessionId=verify-session')
check('health responds', health.status === 200 && health.json().ok === true)
check('capability chose the reversible fork strategy', health.json().capability?.chosen === 'derive-patch', health.text)

// --- planning ----------------------------------------------------------------
const candidates = await dispatch('GET', '/api/dsh-rewind-pro/candidates?sessionId=verify-session')
check('candidates list user turns', candidates.json().candidates?.map((c) => c.seq).join(',') === '3,1', candidates.text)

const plan = await dispatch('GET', '/api/dsh-rewind-pro/plan?sessionId=verify-session&targetSeq=3')
check('impact counts turns', plan.json().impact?.turns?.length === 2, plan.text)

// --- phase one: mark (no session mutation) -----------------------------------
const marked = await dispatch('POST', '/api/dsh-rewind-pro/mark', { sessionId, targetSeq: 3 })
check('mark enters pending', marked.status === 200 && marked.json().pending?.targetSeq === 3, marked.text)
check('mark does not fork yet', forkCalls.length === 0, JSON.stringify(forkCalls))

// --- cancel ------------------------------------------------------------------
await dispatch('POST', '/api/dsh-rewind-pro/cancel', { sessionId })
const afterCancel = await dispatch('GET', '/api/dsh-rewind-pro/state?sessionId=verify-session')
check('cancel clears pending', afterCancel.json().pending === null)

// --- file checkpoint via the session firehose --------------------------------
const parser = path.join(workspace, 'src', 'parser.ts')
await mkdir(path.dirname(parser), { recursive: true })
await writeFile(parser, 'v1', 'utf8')
const onSessionEvent = firehose.get('session/event')
check('session/event bound', typeof onSessionEvent === 'function')
// The bus is POSITIONAL: (session, event). A handler expecting one {session,
// event} bag silently receives undefined for both — the original bug.
onSessionEvent(session, {
  type: 'tool/call',
  seq: 4,
  data: { name: 'str_replace_editor', arguments: JSON.stringify({ path: parser }) },
})
await new Promise((resolve) => setTimeout(resolve, 80))
await writeFile(parser, 'v2-overwritten', 'utf8')

// --- commit: fork at the boundary + restore checkpointed files ---------------
await dispatch('POST', '/api/dsh-rewind-pro/mark', { sessionId, targetSeq: 3 })
const committed = await dispatch('POST', '/api/dsh-rewind-pro/commit', { sessionId })
check('commit records the hidden range', JSON.stringify(committed.json().ranges) === JSON.stringify([{ start: 3, end: 4 }]), committed.text)
check('commit forked at the boundary (seq 2 kept)', JSON.stringify(forkCalls) === '[2]', JSON.stringify(forkCalls))
check('commit restored the pre-write file content', (await readFile(parser, 'utf8')) === 'v1', await readFile(parser, 'utf8'))

// --- undo + jump --------------------------------------------------------------
const undone = await dispatch('POST', '/api/dsh-rewind-pro/undo', { sessionId })
check('undo grades clean and applies', undone.json().grade === 'clean' && undone.json().applied === true, undone.text)

const state = await dispatch('GET', '/api/dsh-rewind-pro/state?sessionId=verify-session')
check('history is append-only and non-empty', state.json().history?.length >= 4, String(state.json().history?.length))

const jumped = await dispatch('POST', '/api/dsh-rewind-pro/jump', { sessionId, toIndex: 3 })
check('jump re-applies an earlier state', jumped.status === 200 && JSON.stringify(jumped.json().ranges) === JSON.stringify([{ start: 3, end: 4 }]), jumped.text)

// --- refusals -----------------------------------------------------------------
const bad = await dispatch('GET', '/api/dsh-rewind-pro/state?sessionId=../../etc')
check('unsafe session id refused', bad.json().error === 'bad-session-id')
const missing = await dispatch('GET', '/api/dsh-rewind-pro/nope?sessionId=verify-session')
check('unknown route 404s', missing.status === 404)

// --- commands -----------------------------------------------------------------
check('four commands registered', ['rewind', 'rewind-undo', 'rewind-history', 'rewind-export-clean'].every((n) => registered.includes(n)), registered.join(','))
check('every command carries discovery metadata', commandDefs.length === 4 && commandDefs.every((d) => typeof d.description === 'string' && d.description.length > 0), JSON.stringify(commandDefs.map((d) => d.name)))
check('the route mounts inside the injected child effect', effectUsed === 1, String(effectUsed))
if (lastAppend) {
  const op = lastAppend.opts?.surfaceOp
  check('surface fold uses startSeq/endSeq', op !== undefined && 'startSeq' in op && 'endSeq' in op && !('start' in op), JSON.stringify(op))
} else {
  check('surface fold untouched when the reversible strategy wins', lastAppend === null)
}

await rm(work, { recursive: true, force: true })

if (failures > 0) {
  console.error(`verify-host: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('verify-host: all checks passed')
void base

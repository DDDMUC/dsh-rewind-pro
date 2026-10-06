# Client ⇄ host contract

The client half is a self-contained bundle that knows nothing about the host
implementation — only this document.

## Addressing

- Base prefix: `/api/dsh-rewind-pro` (constant `API_PREFIX`); a profile may
  override it with `config.apiPrefix` and the client honours `config.apiPrefix` too.
- Same-origin only. There is no `__DSH_API_BASE__` in this harness and the
  client never needs one.
- Every response is JSON. Errors are status codes; the client treats `>= 400`
  as "operation refused" and stays usable.

## Endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/health` | `?sessionId` | `{ ok, capability }` |
| GET | `/state` | `?sessionId` | `SessionView` |
| GET | `/candidates` | `?sessionId` | `{ candidates: [{ seq, preview, ordinal }] }` |
| GET | `/plan` | `?sessionId&targetSeq` | `{ impact }` |
| POST | `/mark` | `{ sessionId, targetSeq }` | `SessionView` (pending set) |
| POST | `/cancel` | `{ sessionId }` | `SessionView` |
| POST | `/commit` | `{ sessionId }` | `SessionView` |
| POST | `/undo` | `{ sessionId, opId?, force? }` | `{ grade, applied, notice?, state }` |
| POST | `/jump` | `{ sessionId, toIndex }` | `SessionView` |
| POST | `/sync` | `{ sessionId, state, originClientId }` | `{ adopted, version }` |
| GET | `/events` | `?sessionId` | SSE stream |

`409` marks a refused transition (`nothing-pending`, `stale-epoch`,
`target-not-found`); `400` marks a bad session id or bad index — the client
shows these, never retries them blindly.

## SessionView

```jsonc
{
  "version": 12,             // monotonic per session
  "sessionId": "…",
  "ranges": [{ "start": 5, "end": 9 }],   // hidden seq ranges (effective)
  "pending": null | { "opId": "…", "targetSeq": 5, "epoch": "…", "strategy": "derive-patch" },
  "history": [{ "opId": "…", "kind": "commit", "targetSeq": 5, "time": …, "reversible": true }],
  "capability": { "dshVersion": "…", "canPatchDeriveMessages": true, "canAppendSurfaceOp": false, "reversible": true, "chosen": "derive-patch" },
  "epoch": "…"
}
```

## SSE

`GET /events?sessionId=…` emits named events:

```
event: state
data: { ...SessionView }

: ping            (heartbeat every 25s)
```

Frames are parsed leniently (heartbeats and junk ignored). Losing the stream is
not an error: the store keeps the last state and `refresh()` can poll.

## Multi-tab rules

1. Monotonic version: a state with `version <= local` is dropped.
2. Echo suppression: a state carrying our own `originClientId` is dropped.
3. Tabs additionally fan out over `BroadcastChannel('dsh-rewind-pro')` so a
   second tab converges without waiting for the next host push.

## Slots

Client components are registered with `ctx.slots.inject(name, () =>
ctx.slots.register(Component))`. Components receive **props only** — they never
get a `ctx`. Currently probed slot names: `settings`, `dock`. The per-message ↶
button is **not** a slot: it is our own overlay container (never appended into a
React-managed node), positioned over detected user turns and cleaned up on
dispose.

## Draft stash

Before a `mark`, the host stashes the composer text server-side; the client
also keeps it in `sessionStorage` keyed by session so a cancel in this tab can
restore it. `take()` reads once and forgets.

# Architecture

## Two halves, one contract

`dsh-rewind-pro` ships two artifacts:

| Artifact | Runtime | Entry | Knows about |
|---|---|---|---|
| `lib/index.js` | Node (ESM) | cordis plugin `apply(ctx)` | ledger, snapshot engine, HTTP+SSE, commands |
| `lib/client.js` | browser | `window.__ModuleLoader__.load({id, factory})` | React UI, SSE + BroadcastChannel, draft stash |

They talk over one same-origin HTTP+SSE surface (`/api/dsh-rewind-pro`, overridable
via `config.apiPrefix`). There is no build-time coupling between them: the client
knows only the wire contract in [contract/client-contract.md](contract/client-contract.md).

## The invariant

**The session log is append-only.** The plugin never edits or deletes a session
event. Rewinding is a *view* over the log:

- `derive-patch` — the primary strategy. The harness is asked to exclude seq
  ranges from derived messages. Removing the range restores the turns, which is
  exactly what undo does.
- `surface-op` — degraded fallback when the harness cannot patch derived
  messages. The tail is folded into one placeholder. **Not reversible**; the UI
  disables undo and offers read-only viewing.
- `ui-only` — last resort: nothing touches the session, the client hides the
  tail locally. Fully reversible.

Which strategy runs is decided at runtime by `core/capability.ts` (probe once,
cache, re-probe when the harness version changes — so a DSH upgrade can silently
upgrade the strategy).

## The two-phase rewind

```
↶ button / /rewind
   │
   ▼
mark ──── interrupt running turn, mask tail, stash draft, fill target text
   │       ledger: { kind: 'mark', targetSeq, strategy, epoch }
   ▼
pending ── survives process restarts (ledger replay re-derives it)
   │
   ├── send ──── commit: pre-step is the main path, session-event is the
   │             fallback; ledger: { kind: 'commit', range }
   └── ✕ ─────── cancel: un-mask, restore stashed draft
                  ledger: { kind: 'cancel', refOpId }
```

The draft stash is the small detail that makes the feature usable: whatever the
user was typing when they hit ↶ comes back if they cancel.

## Undo grading

`core/undo-policy.ts` answers "can I take this back?" honestly:

| Grade | Meaning | UI |
|---|---|---|
| `clean` | nothing was written after the rewind | undo immediately |
| `dirty` | N turns were written on top; un-hiding splices them into a history the model never saw | force a second confirm, show N |
| `irreversible` | surface-op folded the tail away | disable undo, read-only view |
| `none` | nothing to undo, or the session epoch changed | explain |

`jump` moves the ledger cursor to an earlier op (history panel / undo+redo of
rewind history). It is recorded, never destructive.

## Snapshot engine

Workspace files are checkpointed **before** a write lands (write-tool hook,
including subagent sessions, tagged with `agentId`):

```
guard      ignore node_modules/.git/dist…, 5 MB cap, NUL-sniff binaries,
           lstat symlinks (never follow), never leave the workspace root
store      content-addressed blobs, dedup across paths and turns,
           per-session serial queue, atomic tmp→rename writes
restore    hash-compare against disk → idempotent; anything divergent is
           MOVED to rescue, never deleted; missing files are recreated
journal    append-only JSONL per restore; a crash mid-restore is finished
           on the next start (steps are idempotent by construction)
cleanup    anchors pruned to maxAnchorGroups (blobs shared with survivors
           are kept), rescue dirs pruned to rescueRetention
```

A wrong rewind is never data loss: the pre-rewind content is in rescue, and
undo restores the post-rewind content from the last commit's checkpoint.

## Never trust, never throw

- session ids are sanitized before they reach the filesystem
- every HTTP failure is a status code, never an exception into the host
- every write is atomic (`tmp` → `rename`)
- a corrupt ledger is moved aside and the session starts clean
- `apply()` wraps everything: a broken plugin degrades, it does not brick DSH

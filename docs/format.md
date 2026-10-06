# On-disk formats

Everything the plugin writes lives under the DSH home (or `ctx.root` in tests):

```
<dsh-home>/
├── rewind-pro/
│   └── ledgers/<sessionId>.json          # one append-only ledger per session
└── rewind-pro-snapshots/
    └── sessions/<sessionId>/
        ├── anchors/<turnKey>.json        # one checkpoint per turn key
        ├── blobs/<sha256>                # content-addressed file contents
        ├── rescue/<restoreId>/<relpath>  # soft-deleted before overwrite
        └── journals/<restoreId>.jsonl    # crash-safe restore journal
```

`<sessionId>` and `<turnKey>` are sanitized (`[^A-Za-z0-9._-]` → `_`, `..`
collapsed); they can never traverse out of the store.

## Ledger (`ledgers/<sessionId>.json`)

```jsonc
{
  "version": 7,                 // monotonic; clients short-circuit on <=
  "originClientId": "tab-a1b2", // echo suppression across tabs
  "ops": [
    { "kind": "mark",   "opId": "…", "targetSeq": 5, "strategy": "derive-patch", "time": 1730000000000, "epoch": "epoch-1" },
    { "kind": "cancel", "opId": "…", "refOpId": "…", "time": …, "epoch": … },
    { "kind": "commit", "opId": "…", "refOpId": "…", "range": { "start": 5, "end": 9 }, "strategy": …, "time": …, "epoch": …, "snapshotOpId": "…" },
    { "kind": "unwind", "opId": "…", "refOpId": "…", "time": …, "epoch": … },
    { "kind": "jump",   "opId": "…", "toIndex": 3, "time": …, "epoch": … }
  ]
}
```

- append-only: `commit`/`cancel` reference the `mark` they resolve; `unwind`
  references the `commit` it reverses. Nothing is ever rewritten.
- `epoch` is the session generation. A pending from a past epoch is refused at
  commit time (`stale-epoch`) and graded `none` by undo.
- writes are atomic (`<file>.<pid>.tmp` → rename); a torn file is renamed to
  `<file>.corrupt-<ts>` and the session restarts from empty.

Replay (`core/ledger.ts`) is pure: ranges, pending state and history are
re-derived from ops, which is what makes pending survive restarts.

## Anchor (`anchors/turn-<seq>.json`)

```jsonc
{
  "key": "turn-4",
  "sessionId": "…",
  "createdAt": 1730000000000,
  "files": [
    { "path": "src/parser.ts", "sha256": "…", "size": 123, "mtimeMs": 1730000000000, "agentId": "sub-7" }
  ]
}
```

`agentId` is present when the edit came from a subagent session.

## Restore journal (`journals/<restoreId>.jsonl`)

```
{"type":"header","restoreId":"…","sessionId":"…","anchorKey":"turn-4","startedAt":…}
{"type":"step","path":"src/a.ts","action":"rescue","status":"planned","time":…}
{"type":"step","path":"src/a.ts","action":"rescue","status":"done","rescuePath":"…","time":…}
{"type":"close","at":…}
```

Append-only; later lines win when merging by `path:action`. A journal without a
`close` line means the restore was interrupted — `resumeRestore` finishes it on
the next start. Steps are idempotent (hash compare), so replaying them is safe.

## Rescue directory

Mirrors the workspace relative paths (`rescue/<restoreId>/src/parser.ts`). A
name collision never overwrites: `a.txt` → `a-1.txt` → … Moving uses `rename`,
falls back to copy → verify size → unlink on `EXDEV`; cross-volume copies are
bounded by `maxFileBytes`.

## Legacy markers (read-only)

`core/migrate.ts` reads older rewind plugins' state files, never rewrites them.
It accepts `{hiddenRanges|ranges|masked|surfaceOps|collapsed}` with `{start,end}`
/ `{from,to}` / `[start,end]` shapes, classifies the source, and emits
`mark+commit` ledger ops that reproduce the same state under the new model.
`summarizeMigration` produces the quiet badge. Scanning is always dry-run;
appending is the host's explicit decision.

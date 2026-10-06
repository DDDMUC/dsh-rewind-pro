# dsh-rewind-pro

[中文](README.md) · Conversation rewind for DeepSeek Harness (DSH) — **rewind that never traps you**.

## What it is

Undoable time travel for DSH sessions:

- **Cancellable two-phase rewind** — the ↶ button next to a user turn arms a rewind: it interrupts the running turn, masks the tail, and fills the composer with the target message. **Sending confirms it**; ✕ cancels everything — including restoring whatever you had half-typed in the composer.
- **Undo & rewind history** (the differentiator) — every rewind can be undone, and the history panel jumps to any point. Undo is graded first: clean → undo immediately; divergent → forced second confirm telling you how many turns diverged; unsupported → told honestly, with read-only viewing of what was hidden.
- **Workspace file restore** — every file write is checkpointed first (subagent writes included, tagged by agent). Rewind restores file-by-file via hash comparison, idempotently; divergent content is **moved to a rescue directory before being overwritten** — never deleted. A restore interrupted by a crash resumes on the next start.
- **Honest impact list** — before confirming you see how many turns will be withdrawn, which files will be restored, and — in plain text — how many shell calls in that range cannot be undone.
- **Multi-strategy masking + version self-healing** — reversible derive-patch first, degrading to surface-op / ui-only when the harness lacks the capability; the capability cache invalidates on harness version change, so an upgrade can silently improve the strategy.
- **`/rewind` command family** — candidate list with keyboard navigation, `/rewind-undo`, `/rewind-history`, and `/rewind-export-clean` (a sanitized transcript that removes rewound turns but *says what it removed*).
- **Multi-tab sync** — monotonic ledger version + echo suppression, SSE + BroadcastChannel.
- **Invariants** — the session log is append-only and never rewritten; every JSON write is atomic (tmp → rename); every failure is a status code, never an exception into the host.

## Install

```bash
dsh plugin --profile web add dsh-rewind-pro
# or a local path
dsh plugin --profile web add /path/to/dsh-rewind
```

Defaults live in `cordis.patch.yml` (strategy / snapshot / trackSubagent / maxAnchorGroups / maxFileBytes / rescueRetention / apiPrefix); every knob is overridable per profile.

## Development

```bash
npm install
npm run check        # typecheck + vitest + build + end-to-end verify-host + pack dry-run
npm run check:version
```

- Zero runtime dependencies: the host half uses Node built-ins only; the client half takes React from the harness's frozen module table.
- Tests: `tests/host` (Node) + `tests/client` (happy-dom).
- End-to-end: `npm run verify:host` drives the built artifact over a real socket through mark → cancel → commit → file restore → undo → jump.

## Docs

- [Architecture](docs/architecture.md) — two halves, two-phase rewind, undo grading, snapshot engine
- [On-disk formats](docs/format.md) — exact ledger / anchor / journal / rescue formats
- [Compatibility audit](docs/compat/audit.md) — which harness interfaces are probed, which are still unverified
- [Client contract](docs/contract/client-contract.md) — the full HTTP/SSE/slots contract

## Compatibility

Target host: DSH `0.1.2-rc.1` (tested locally). Harness interfaces bind via **runtime probing**; anything unprobed degrades instead of crashing. See the compatibility audit for the current state.

## License

[MIT](LICENSE)

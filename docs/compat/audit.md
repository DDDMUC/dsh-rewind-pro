# Harness compatibility audit

Status: **initial audit — partially unverified on a live harness.** This file is
the honesty ledger: what this plugin assumes about DSH, what it verifies at
runtime, and what a release audit must confirm. No fabricated API is allowed in
this codebase; everything unverified goes through a probe with a fallback.

## What was audited against a real install

| Fact | Source | Used by |
|---|---|---|
| Plugins are loaded by the harness with a cordis-style `ctx`; `ctx.inject` exists | local DSH install (`C:\Users\MVT\.dsh\profiles\web`), plugin ecosystem packages | `src/index.ts` lazy web-server mount |
| Client halves are served to the web shell; `window.__ModuleLoader__.load({id, factory})` is the materialization contract | harness client runtime; loader closure verified in our build output | `scripts/build.mjs` banner/footer |
| React is available to client halves through the frozen module table | harness client runtime | `react`, `react-dom/client` esbuild externals |
| No `__DSH_API_BASE__` global exists; same-origin `/api/...` is the addressing model | absence verified locally | `src/client/contract.ts` single prefix constant |
| No `deriveMessages` / `appendSurfaceOp` typed surface found in the profile's `@deepseek-ai` packages | local type scan (0 hits) | duck-typed probes in `src/host/adapter.ts` |

## What is deliberately duck-typed (and why)

The session surface (`deriveMessages`, surface ops, interrupt, draft input,
command registry, event bus) is **not** statically imported. `detectAdapter(ctx)`
probes for it at runtime and degrades:

| Probe | Found? | Degradation |
|---|---|---|
| `ctx.session/agent/dsh.messages` | no | `null adapter`: ui-only, no-ops; UI still renders |
| `session.deriveMessages` / `patchDeriveMessages` | yes | `derive-patch` available |
| `session.appendSurfaceOp` / `appendOp` | yes | `surface-op` fallback |
| `session.interrupt/abort/stop` | yes | mark can stop a running turn |
| `session.setDraft/getDraft` | yes | two-phase draft flow works |
| `ctx.registerCommand` | yes | `/rewind*` commands registered |
| `ctx.on` | yes | `before-step` / `session-event` / `before-write` hooks bound |
| `ctx.inject(['webServer','httpServer'])` | yes | HTTP+SSE mounted; otherwise headless silent skip |

Probing means a new DSH release that renames a method degrades to ui-only with a
logged note instead of crashing the harness.

## UNKNOWN / to verify on the live harness (release checklist)

These are the points `npm run verify:host` cannot decide and a live session
must:

1. **Real message `seq` semantics** — does the harness expose a stable per-turn
   sequence? If ids are strings, `MessageLite` mapping in `adapter.ts` needs the
   real field name.
2. **`deriveMessages` patch shape** — we send `HiddenRange[]`; confirm the
   harness accepts ranges (vs. per-message patches) and returns the derived
   list synchronously.
3. **Pre-step event name** — we bind `before-step`; if the real event differs,
   the session-event fallback still commits, but the confirm hint should say so.
4. **Subagent session linkage** — parent/child session ids and their event
   routing; `trackSubagent` captures writes seen through the write hook either way.
5. **Slot names** — we try `settings` and `dock`; confirm the real names and the
   props contract (components receive props only, never `ctx`).
6. **CSS token names** — `--dsw-alias-*` with plain fallbacks; confirm real token
   names for float background / border / danger.
7. **Legacy marker locations** — no old `dsh-rewind` install was found on the
   audit machine, so `core/migrate.ts` shapes are best-effort tolerant parsers;
   verify against real state files when encountered.

## Version policy

`package.json` declares audited tuples under `dsh.compatibility.dshReleases`.
`npm run check:version` fails CI when npm publishes a DSH release outside the
audited set, forcing a new audit before a version bump.

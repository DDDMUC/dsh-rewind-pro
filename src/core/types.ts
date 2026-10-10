// dsh-rewind-pro — shared contract types.
//
// These types are the plugin's single source of truth, shared by the host
// half (Node) and the client half (browser). Keep this file dependency-free:
// it must compile under both tsconfig.host.json (NodeNext) and
// tsconfig.client.json (bundler + DOM).

/** Masking strategy actually in effect for a session. */
export type Strategy = 'derive-patch' | 'surface-op' | 'ui-only'

/** Inclusive seq range hidden from the model and the chat view. */
export interface HiddenRange {
  start: number
  end: number
}

/** One append-only ledger record. The ledger is the only source of truth. */
export type LedgerOp =
  | {
      kind: 'mark'
      opId: string
      targetSeq: number
      strategy: Strategy
      time: number
      epoch: string
      preview?: string
    }
  | { kind: 'cancel'; opId: string; refOpId: string; time: number; epoch: string }
  | {
      kind: 'commit'
      opId: string
      refOpId: string
      range: HiddenRange
      strategy: Strategy
      time: number
      epoch: string
      snapshotOpId?: string
    }
  /** Undo one committed rewind: removes its range again (reversible strategies only). */
  | { kind: 'unwind'; opId: string; refOpId: string; time: number; epoch: string }
  /** History jump: replay ops[0..toIndex]; recorded, never destructive. */
  | { kind: 'jump'; opId: string; toIndex: number; time: number; epoch: string }

export interface LedgerState {
  /** Monotonically increasing; clients short-circuit on incoming.version <= local. */
  version: number
  /** Echo suppression across tabs / surfaces. */
  originClientId?: string
  ops: readonly LedgerOp[]
}

export interface PendingState {
  opId: string
  targetSeq: number
  epoch: string
  strategy: Strategy
}

export interface HistoryEntry {
  opId: string
  kind: LedgerOp['kind']
  /** Target seq for mark/commit/unwind; null for jump/cancel. */
  targetSeq: number | null
  time: number
  reversible: boolean
}

export interface ReplayResult {
  ranges: HiddenRange[]
  pending: PendingState | null
  history: HistoryEntry[]
}

/** Undo grading: the "time paradox" of in-window rewind made explicit. */
export type UndoGrade =
  | { grade: 'clean'; opId: string }
  | { grade: 'dirty'; opId: string; divergentTurns: number; notice: string }
  | { grade: 'irreversible'; opId: string; reason: string }
  | { grade: 'none'; reason: 'no-op' | 'stale-epoch' }

export interface Capability {
  dshVersion: string
  canPatchDeriveMessages: boolean
  canAppendSurfaceOp: boolean
  /** false => the UI must disable undo and explain why. */
  reversible: boolean
  chosen: Strategy
}

/** Normalized view of one tool invocation carried by a message. */
export interface ToolCallLite {
  name: string
  /** Workspace path when the call targets a file. */
  path?: string
  /** Shell / command execution (counted in ImpactPlan.shellCalls). */
  shell?: boolean
  /** Mutating file operation (write / edit / create). */
  write?: boolean
}

/**
 * Host-agnostic message view. The host adapter maps real DSH messages into
 * this shape before core logic ever sees them, which keeps core pure and
 * testable without the harness.
 */
export interface MessageLite {
  seq: number
  role: 'user' | 'assistant' | 'system' | 'tool' | 'other'
  text: string
  toolCalls?: ToolCallLite[]
  /** Steering / interruption message injected mid-turn. */
  steering?: boolean
  /** 稳定消息 id（user/message 在 data.id）—— 投影点名用；取不到就 undefined。 */
  id?: string
}

/** One selectable rewind target for the /rewind candidate list. */
export interface RewindCandidate {
  seq: number
  /** 稳定消息 id（活动路径投影点名用；老会话取不到时没有这个字段）。 */
  id?: string
  preview: string
  /** 1-based position from oldest to newest, for stable keyboard navigation. */
  ordinal: number
}

/** Context of "now" used to grade how safe an undo is. */
export interface UndoContext {
  /** Highest seq currently present in the session. */
  sessionSeq: number
  strategy: Strategy
  /** Session generation; a mismatch means the undo target is from a past life. */
  epoch?: string
}

/** Impact preview shown before a destructive rewind (both mode). */
export interface ImpactPlan {
  targetSeq: number
  /** Turns (user/assistant pairs) that will be withdrawn. */
  turns: Array<{ seq: number; preview: string; kind: 'user' | 'assistant' | 'steering' | 'other' }>
  /** Files the restore engine will touch. */
  files: Array<{ path: string; action: 'restore' | 'rescue' | 'recreate' | 'skip'; detail?: string }>
  /** Count of shell/tool calls in the withdrawn range (honesty note). */
  shellCalls: number
}

/** Host-side plugin config (defaults live in cordis.patch.yml). */
export interface PluginConfig {
  strategy: 'auto' | Strategy
  snapshot: boolean
  trackSubagent: boolean
  maxAnchorGroups: number
  maxFileBytes: number
  watchPaths: string[]
  rescueRetention: number
  /** Overrides the default `<dsh home>/rewind-pro/` state root (ledgers + snapshots). */
  stateDir?: string
  /** Overrides the default `<dsh home>/rewind-pro-snapshots/` store root. */
  snapshotDir?: string
  /** Workspace whose files get checkpointed; defaults to the process cwd. */
  workspaceRoot?: string
  /** HTTP surface prefix; defaults to /api/dsh-rewind-pro. */
  apiPrefix?: string
  debug?: boolean
}

export const DEFAULT_CONFIG: PluginConfig = {
  strategy: 'auto',
  snapshot: true,
  trackSubagent: true,
  maxAnchorGroups: 100,
  maxFileBytes: 5 * 1024 * 1024,
  watchPaths: [],
  rescueRetention: 10,
}

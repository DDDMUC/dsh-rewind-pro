// The rewind controller: the state machine behind the two-phase rewind.
//
//   mark    interrupt the turn, mask the tail, stash the draft, fill in the
//           target text, append a `mark` op (pending survives a restart)
//   commit  the user sending that text is the confirmation. Pre-step is the
//           main path; a session event is the fallback when pre-step never
//           fires. Appends `commit` with the final range.
//   cancel  un-mask and put the stashed draft back
//   undo    graded: clean / dirty (needs confirmation) / irreversible (refused)
//   jump    move the ledger cursor to an earlier op (history panel)
//
// Every mutation is an append to the ledger; nothing is ever rewritten. The
// controller keeps an in-memory mirror of each session's ops so `state()` stays
// synchronous for the API, and `resume()` reloads it after a restart.

import { randomUUID } from 'node:crypto'
import { createCapabilityCache } from '../core/capability.js'
import { createLedgerStore } from '../core/ledger-store.js'
import { mergeRanges, replayDetail } from '../core/ledger.js'
import { listCandidates, planRewind } from '../core/plan.js'
import { gradeUndo } from '../core/undo-policy.js'
import { buildSurfaceOp } from '../core/strategy-surface.js'
import type { CapabilityProbe } from '../core/capability.js'
import type { HistoryEntry } from '../core/types.js'
import type {
  Capability,
  HiddenRange,
  ImpactPlan,
  LedgerOp,
  MessageLite,
  PendingState,
  PluginConfig,
  RewindCandidate,
  Strategy,
  UndoGrade,
} from '../core/types.js'
import { captureBeforeWrite } from '../snapshot/capture.js'
import { createSnapshotStore } from '../snapshot/store.js'
import { restoreAnchor } from '../snapshot/restore.js'
import type { Anchor, SnapshotStore } from '../snapshot/store.js'
import type { HarnessAdapter } from './adapter.js'

export interface ControllerDeps {
  adapter: HarnessAdapter
  /** Directory holding `<sessionId>.json` ledgers. */
  ledgerDir: string
  snapshotRoot: string
  workspaceRoot: string
  config: PluginConfig
  now?: () => number
}

export type ActionResult = { ok: true } | { ok: false; reason: string }

export interface SessionView {
  version: number
  sessionId: string
  ranges: HiddenRange[]
  pending: PendingState | null
  history: HistoryEntry[]
  capability: Capability
  epoch: string
}

export interface UndoResult {
  grade: UndoGrade['grade']
  applied: boolean
  reason?: string
  divergentTurns?: number
  notice?: string
}

export interface RewindController {
  workspaceRoot: string
  capability: () => Capability
  state: (sessionId: string) => SessionView
  /**
   * 候选列表。默认 20 条（回退列表的 UX 依赖这个口径）；
   * 定位很老的消息时需要更宽 —— 调用方可以指定 limit。
   */
  candidates: (sessionId: string, limit?: number) => RewindCandidate[]
  impact: (sessionId: string, targetSeq: number) => ImpactPlan | null
  mark: (input: { sessionId: string; targetSeq: number }) => Promise<ActionResult>
  /**
   * 「分页重跑」：把目标消息之后的内容从模型上下文里遮蔽掉，然后用改写后的文本
   * **真的**重新提示一次（模型会重新生成）。
   *
   * 两步顺序不可颠倒：先遮蔽再重跑，历史里才会只有一条提示词。反过来会把新
   * 提示词追加到还没遮蔽的旧历史后面，模型会看到两份。
   */
  applyBranch: (input: {
    sessionId: string
    targetSeq: number
    text: string
    /** 投递模式：空闲会话用 queue，正忙的会话要 steer 才会立刻落地。 */
    mode?: 'queue' | 'steer'
  }) => Promise<{ ok: boolean; reason?: string; shadowed?: boolean; shadowedSeqs?: number[] }>
  cancel: (input: { sessionId: string }) => Promise<ActionResult>
  commit: (input: { sessionId: string }) => Promise<ActionResult>
  undo: (input: { sessionId: string; opId?: string; force?: boolean }) => Promise<UndoResult>
  jump: (input: { sessionId: string; toIndex: number }) => Promise<ActionResult>
  handleBeforeStep: (input: { sessionId: string; text: string }) => Promise<{ committed: boolean; reason?: string }>
  handleSessionEvent: (input: {
    sessionId: string
    type: string
    payload: { seq?: number; role?: string; text?: string }
  }) => Promise<{ committed: boolean; reason?: string }>
  handleBeforeWrite: (input: {
    sessionId: string
    absPath: string
    turnSeq: number
    agentId?: string
  }) => Promise<{ captured: boolean; reason?: string }>
  /** Reload the ledger and re-apply the persisted masking (after a restart). */
  resume: (sessionId: string) => Promise<void>
  snapshotAnchor: (sessionId: string, key: string) => Promise<Anchor | null>
  stashedDraft: (sessionId: string) => string | null
}

export function anchorKeyForTurn(turnSeq: number): string {
  return `turn-${turnSeq}`
}

export function createRewindController(deps: ControllerDeps): RewindController {
  const { adapter, config } = deps
  const now = deps.now ?? Date.now

  const ledgerStores = new Map<string, ReturnType<typeof createLedgerStore>>()
  const ledgerFor = (sessionId: string) => {
    const existing = ledgerStores.get(sessionId)
    if (existing) return existing
    const store = createLedgerStore({ dir: deps.ledgerDir, sessionId })
    ledgerStores.set(sessionId, store)
    return store
  }

  const snapshots: SnapshotStore = createSnapshotStore(deps.snapshotRoot)

  const probe: CapabilityProbe = {
    dshVersion: () => adapter.dshVersion(),
    // On the real harness "patchable derive" does not exist; the reversible
    // primitive is the session fork, so that is what this capability means.
    canPatchDeriveMessages: () => adapter.canFork(),
    canAppendSurfaceOp: () => adapter.canAppendSurfaceOp(),
  }
  const capabilityCache = createCapabilityCache(probe)

  /** In-memory mirror: `state()` must stay synchronous for the HTTP surface. */
  const mirror = new Map<string, LedgerOp[]>()
  const opsOf = (sessionId: string): LedgerOp[] => mirror.get(sessionId) ?? []

  const appendOp = async (sessionId: string, op: LedgerOp): Promise<void> => {
    const state = await ledgerFor(sessionId).append(op, 'host')
    mirror.set(sessionId, [...state.ops])
  }

  /** Drafts stashed when a rewind starts, restored when it is cancelled. */
  const stash = new Map<string, string | null>()

  const strategyFor = (): Strategy => {
    const preferred = config.strategy ?? 'auto'
    const capability = capabilityCache.get()
    if (preferred === 'auto' || preferred === 'ui-only') return preferred === 'ui-only' ? 'ui-only' : capability.chosen
    const supported =
      (preferred === 'derive-patch' && capability.canPatchDeriveMessages) ||
      (preferred === 'surface-op' && capability.canAppendSurfaceOp)
    return supported ? preferred : capability.chosen
  }

  /**
   * Push the effective masking to the harness according to the strategy.
   * derive-patch (fork): the session is never mutated while pending — the
   * client hides the tail locally, and the fork happens at commit time, which
   * is what makes undo trivially possible (the parent log is append-only).
   */
  const applyMasking = async (sessionId: string, ranges: HiddenRange[]): Promise<boolean> => {
    const strategy = strategyFor()
    if (strategy === 'derive-patch') return true
    if (strategy === 'surface-op') {
      const range = ranges[ranges.length - 1]
      if (!range) return true
      return adapter.appendSurfaceOp(
        buildSurfaceOp(range, `${range.end - range.start + 1} turns hidden by rewind`),
        sessionId,
      )
    }
    // ui-only: the client hides the tail locally, nothing to push.
    return true
  }

  const messageAt = (seq: number, sessionId: string): MessageLite | null =>
    adapter.messagesOf(sessionId).find((message) => message.seq === seq) ?? null

  const viewOf = (sessionId: string): SessionView => {
    const ops = opsOf(sessionId)
    const detail = replayDetail(ops)
    return {
      // The ledger is append-only, so the op count is a monotonic version.
      version: ops.length,
      sessionId,
      ranges: detail.ranges,
      pending: detail.pending,
      history: detail.history,
      capability: capabilityCache.get(),
      epoch: adapter.epoch(sessionId),
    }
  }

  const commitPending = async ({ sessionId }: { sessionId: string }): Promise<ActionResult> => {
    const pending = viewOf(sessionId).pending
    if (!pending) return { ok: false, reason: 'nothing-pending' }
    if (pending.epoch !== adapter.epoch(sessionId)) return { ok: false, reason: 'stale-epoch' }

    const range: HiddenRange = { start: pending.targetSeq, end: adapter.sessionSeq(sessionId) }
    let snapshotOpId: string | undefined

    if (pending.strategy === 'derive-patch') {
      // Reversible rewind: fork the session at the boundary. The parent log
      // stays untouched — that is exactly what undo will follow back to.
      const boundary = Math.max(0, range.start - 1)
      const fork = await adapter.forkSession(boundary, sessionId)
      if (!fork.ok) return { ok: false, reason: fork.reason ?? 'fork-failed' }
      snapshotOpId = `fork:${fork.childId ?? ''}`
      await adapter.followSession(fork.childId ?? sessionId)
    } else {
      await applyMasking(sessionId, [...viewOf(sessionId).ranges, range])
      if (config.snapshot && (await restoreTurnFiles(sessionId, range))) {
        snapshotOpId = snapshotOpId ?? `restore-${pending.opId}`
      }
    }
    // Workspace file restore is independent of the masking strategy: the
    // turns are being withdrawn either way, so their file effects must go
    // back to the checkpointed state.
    if (pending.strategy === 'derive-patch' && config.snapshot) {
      await restoreTurnFiles(sessionId, range)
    }

    await adapter.setDraft('')
    await appendOp(sessionId, {
      kind: 'commit',
      opId: randomUUID(),
      refOpId: pending.opId,
      range,
      strategy: pending.strategy,
      time: now(),
      epoch: pending.epoch,
      ...(snapshotOpId ? { snapshotOpId } : {}),
    })
    return { ok: true }
  }

  /** Restore the files that the turns inside `range` had touched. */
  async function restoreTurnFiles(sessionId: string, range: HiddenRange): Promise<boolean> {
    let restored = false
    for (let seq = range.start; seq <= range.end; seq++) {
      const anchor = await snapshots.readAnchor(sessionId, anchorKeyForTurn(seq))
      if (!anchor || anchor.files.length === 0) continue
      await restoreAnchor(snapshots, {
        sessionId,
        anchorKey: anchor.key,
        root: deps.workspaceRoot,
        restoreId: `${sessionId}-${seq}`,
        maxFileBytes: config.maxFileBytes,
      })
      restored = true
    }
    return restored
  }

  return {
    workspaceRoot: deps.workspaceRoot,

    capability: () => capabilityCache.get(),

    state: viewOf,

    candidates: (sessionId, limit) => listCandidates(adapter.messagesOf(sessionId), limit),

    impact: (sessionId, targetSeq) => {
      if (!messageAt(targetSeq, sessionId)) return null
      return planRewind(adapter.messagesOf(sessionId), targetSeq)
    },

    /**
     * 分页重跑：**先遮蔽、再重跑**。
     *
     * 每一步都有明确的前置：规划不出来就什么都不做；遮蔽失败就绝不重跑
     * （否则等于往一份没遮蔽的历史里再塞一条提示词，模型会看到两份）。
     * 遮蔽成功而重跑被拒时，`shadowed: true` 如实说明日志已经变了。
     */
    async applyBranch({ sessionId, targetSeq, text, mode = 'queue' }) {
      // 先确认"能重跑"再动手遮蔽：遮蔽成功而重跑失败会留下半完成状态
      // （那段历史被遮掉、却没有新提示词补上），真机上踩过一次。
      if (!adapter.canPrompt()) {
        return {
          ok: false,
          reason: '宿主没有可用的 sessionController.prompt，已取消（没有写入任何遮蔽）',
          shadowed: false,
        }
      }

      const planned = adapter.planShadowFor(targetSeq, sessionId)
      if (!planned.ok) return { ok: false, reason: planned.reason, shadowed: false }

      const shadow = await adapter.shadowWindow(sessionId, planned.plan, planned.expectedSeq)
      if (!shadow.ok) {
        return { ok: false, reason: shadow.reason ?? 'shadow-failed', shadowed: false }
      }

      // "被接受"不等于"落地"：DSH 会把 requestId 持久化在**被接受的那条用户
      // 消息**上，所以消息数没变就说明它根本没进日志（真机上遇到过：会话未激活）。
      const messagesBefore = adapter.messagesOf(sessionId).length
      const prompted = await adapter.promptSession(sessionId, text, mode)
      if (!prompted.ok) {
        return {
          ok: false,
          reason: prompted.reason ?? 'prompt-failed',
          shadowed: true,
          shadowedSeqs: planned.plan.shadowed,
        }
      }
      if (adapter.messagesOf(sessionId).length <= messagesBefore) {
        // 会话正忙时 `queue` 只会排队等当前回合结束（真机上表现为「被接受却不落地」）。
        // 换另一个模式再试一次：`steer` 是往正在进行的回合里注入。
        const other: 'queue' | 'steer' = mode === 'steer' ? 'queue' : 'steer'
        const retry = await adapter.promptSession(sessionId, text, other)
        if (retry.ok && adapter.messagesOf(sessionId).length > messagesBefore) {
          return { ok: true, shadowed: true, shadowedSeqs: planned.plan.shadowed }
        }
        return {
          ok: false,
          reason: '提示词没有被会话接受（会话可能未激活）：请先在浏览器里打开这条对话，再点一次分页重跑。',
          shadowed: true,
          shadowedSeqs: planned.plan.shadowed,
        }
      }
      return { ok: true, shadowed: true, shadowedSeqs: planned.plan.shadowed }
    },

    async mark({ sessionId, targetSeq }) {
      const target = messageAt(targetSeq, sessionId)
      if (!target) return { ok: false, reason: 'target-not-found' }

      // Whatever the user had typed must survive a cancel.
      stash.set(sessionId, adapter.getDraft())

      // Stop the running turn first: otherwise the tail keeps growing under us
      // and the committed range would be wrong.
      await adapter.interruptTurn()

      const pendingRange: HiddenRange = { start: targetSeq, end: adapter.sessionSeq(sessionId) }
      await applyMasking(sessionId, [...viewOf(sessionId).ranges, pendingRange])
      await adapter.setDraft(target.text)

      await appendOp(sessionId, {
        kind: 'mark',
        opId: randomUUID(),
        targetSeq,
        strategy: strategyFor(),
        time: now(),
        epoch: adapter.epoch(sessionId),
      })
      return { ok: true }
    },

    async cancel({ sessionId }) {
      const pending = viewOf(sessionId).pending
      if (!pending) return { ok: false, reason: 'nothing-pending' }

      await applyMasking(sessionId, viewOf(sessionId).ranges)
      await adapter.setDraft(stash.get(sessionId) ?? '')
      stash.delete(sessionId)

      await appendOp(sessionId, {
        kind: 'cancel',
        opId: randomUUID(),
        refOpId: pending.opId,
        time: now(),
        epoch: adapter.epoch(sessionId),
      })
      return { ok: true }
    },

    commit: commitPending,

    async undo({ sessionId, opId, force }) {
      const grade = gradeUndo(
        opsOf(sessionId),
        { sessionSeq: adapter.sessionSeq(sessionId), strategy: strategyFor(), epoch: adapter.epoch(sessionId) },
        opId,
      )

      if (grade.grade === 'none') return { grade: 'none', applied: false, reason: grade.reason }
      if (grade.grade === 'irreversible') return { grade: 'irreversible', applied: false, reason: grade.reason }
      if (grade.grade === 'dirty' && !force) {
        return { grade: 'dirty', applied: false, divergentTurns: grade.divergentTurns, notice: grade.notice }
      }

      await appendOp(sessionId, {
        kind: 'unwind',
        opId: randomUUID(),
        refOpId: grade.opId,
        time: now(),
        epoch: adapter.epoch(sessionId),
      })
      if (grade.grade === 'clean' || grade.grade === 'dirty') {
        // A fork rewind never touched the parent log: undo is following the
        // client back to the parent session, nothing to un-mask.
        const commit = viewOf(sessionId).history.find((entry) => entry.opId === grade.opId)
        void commit
        await applyMasking(sessionId, viewOf(sessionId).ranges)
        await adapter.followSession(sessionId)
      } else {
        await applyMasking(sessionId, viewOf(sessionId).ranges)
      }
      return { grade: grade.grade, applied: true }
    },

    async jump({ sessionId, toIndex }) {
      const ops = opsOf(sessionId)
      if (toIndex < 0 || toIndex >= ops.length) return { ok: false, reason: 'out-of-range' }
      await appendOp(sessionId, {
        kind: 'jump',
        opId: randomUUID(),
        toIndex,
        time: now(),
        epoch: adapter.epoch(sessionId),
      })
      await applyMasking(sessionId, viewOf(sessionId).ranges)
      return { ok: true }
    },

    async handleBeforeStep({ sessionId }) {
      const result = await commitPending({ sessionId })
      return result.ok ? { committed: true } : { committed: false, reason: 'reason' in result ? result.reason : undefined }
    },

    async handleSessionEvent({ sessionId, type, payload }) {
      if (type !== 'message' || payload.role !== 'user') return { committed: false, reason: 'not-a-user-turn' }
      const pending = viewOf(sessionId).pending
      if (!pending) return { committed: false, reason: 'nothing-pending' }
      // The confirming turn is the one written *after* the rewind target.
      if (typeof payload.seq === 'number' && payload.seq <= pending.targetSeq) {
        return { committed: false, reason: 'not-the-confirming-turn' }
      }
      const result = await commitPending({ sessionId })
      return result.ok ? { committed: true } : { committed: false, reason: 'reason' in result ? result.reason : undefined }
    },

    async handleBeforeWrite({ sessionId, absPath, turnSeq, agentId }) {
      const result = await captureBeforeWrite(snapshots, {
        sessionId,
        anchorKey: anchorKeyForTurn(turnSeq),
        root: deps.workspaceRoot,
        absPath,
        maxFileBytes: config.maxFileBytes,
        ...(agentId ? { agentId } : {}),
      })
      return result.captured ? { captured: true } : { captured: false, reason: result.reason }
    },

    async resume(sessionId) {
      const state = await ledgerFor(sessionId).read()
      mirror.set(sessionId, [...state.ops])
      await applyMasking(sessionId, replayDetail(state.ops).ranges)
    },

    snapshotAnchor: (sessionId, key) => snapshots.readAnchor(sessionId, key),

    stashedDraft: (sessionId) => stash.get(sessionId) ?? null,
  }
}

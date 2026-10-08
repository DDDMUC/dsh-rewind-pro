// In-memory stand-in for the DSH harness. The host half talks only to the
// HarnessAdapter interface, so tests can drive the whole two-phase flow
// without the real harness — and the real adapter can be swapped in later.

import type { CommandSpec, HarnessAdapter } from '../../../src/host/adapter'
import type { HiddenRange, MessageLite } from '../../../src/core/types'
import type { SurfaceOp } from '../../../src/core/strategy-surface'
import type { ShadowPlan } from '../../../src/core/surface-window'

export interface FakeHostOptions {
  messages?: MessageLite[]
  canPatch?: boolean
  canSurface?: boolean
  epoch?: string
}

export class FakeHost implements HarnessAdapter {
  messages: MessageLite[]
  draft: string | null = null
  deriveRanges: HiddenRange[] = []
  surfaceOps: SurfaceOp[] = []
  interrupts = 0
  capabilities: { canPatch: boolean; canSurface: boolean }
  epochValue: string
  version = '0.1.2-rc.1'
  /** Session events the harness would have emitted (user message landed, ...). */
  emitted: Array<{ type: string; payload: unknown }> = []
  written: string[] = []
  /** Fork rewinds performed (boundary = inclusive last kept seq). */
  forks: Array<{ boundary: number }> = []
  /** Session ids the client was asked to follow, in order. */
  followed: string[] = []
  /** Slash commands the plugin asked the harness to register. */
  commands: CommandSpec[] = []

  constructor(options: FakeHostOptions = {}) {
    this.messages = options.messages ?? []
    this.capabilities = { canPatch: options.canPatch ?? true, canSurface: options.canSurface ?? false }
    this.epochValue = options.epoch ?? 'epoch-1'
  }

  dshVersion(): string {
    return this.version
  }
  sessionId(): string {
    return 'session-1'
  }
  /**
   * The reads accept (and ignore) a session id: this fake models ONE session,
   * and its job is only to drive the controller's two-phase flow. Resolving by
   * id is exercised against the real adapter in host-adapter.test.ts.
   */
  epoch(): string {
    return this.epochValue
  }
  messagesOf(): MessageLite[] {
    return this.messages
  }
  sessionSeq(): number {
    return this.messages.reduce((max, m) => Math.max(max, m.seq), 0)
  }
  canPatchDeriveMessages(): boolean {
    return this.capabilities.canPatch
  }
  canAppendSurfaceOp(): boolean {
    return this.capabilities.canSurface
  }
  canFork(): boolean {
    return this.capabilities.canPatch
  }
  /**
   * The projection probe asks a question about the harness, not about a scenario:
   * the fake reports "unsupported" so every test stays on the fork path.
   */
  async probeMessageProjection(): Promise<{ registration: boolean; deletion: boolean; reason?: string }> {
    return { registration: false, deletion: false, reason: 'fake host' }
  }
  async forkSession(boundary: number): Promise<{ ok: boolean; childId?: string; reason?: string }> {
    if (!this.capabilities.canPatch) return { ok: false, reason: 'fork-unavailable' }
    this.forks.push({ boundary })
    // The controller decides when the client follows the new session; the
    // fork itself must not.
    return { ok: true, childId: `${this.sessionId()}-child-${this.forks.length}` }
  }
  async followSession(id: string): Promise<boolean> {
    this.followed.push(id)
    return true
  }
  sessionIds(): string[] {
    return [this.sessionId()]
  }
  async patchDeriveMessages(ranges: HiddenRange[]): Promise<boolean> {
    if (!this.capabilities.canPatch) return false
    this.deriveRanges = ranges
    return true
  }
  async appendSurfaceOp(op: SurfaceOp): Promise<boolean> {
    if (!this.capabilities.canSurface) return false
    this.surfaceOps = [...this.surfaceOps, op]
    return true
  }
  /** 记录"分页重跑"两步，供控制器/路由测试断言（顺序与参数都要能验）。 */
  shadows: { sessionId?: string; plan: ShadowPlan; expectedSeq?: number }[] = []
  prompts: { sessionId: string; text: string }[] = []
  /** 规划结果；默认给一个可用的窗口，测试可以改成失败来验"什么都不做"。 */
  /** 有没有重跑能力；测试里可以关掉来验"连遮蔽都不做"。 */
  canPromptValue = true
  canPrompt(): boolean {
    return this.canPromptValue
  }
  planVerdict: { ok: true; plan: ShadowPlan; expectedSeq?: number } | { ok: false; reason: string } | null = null
  planShadowFor(
    targetSeq: number,
    _sessionId?: string,
  ): { ok: true; plan: ShadowPlan; expectedSeq?: number } | { ok: false; reason: string } {
    if (this.planVerdict) return this.planVerdict
    return {
      ok: true,
      plan: { startSeq: targetSeq, endSeq: targetSeq + 1, shadowed: [targetSeq, targetSeq + 1], turn: 2 },
      expectedSeq: 5,
    }
  }
  async shadowWindow(
    sessionId: string | undefined,
    plan: ShadowPlan,
    expectedSeq?: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    this.shadows.push({ sessionId, plan, expectedSeq })
    return this.shadowVerdict
  }
  shadowVerdict: { ok: boolean; reason?: string } = { ok: true }
  /** prompt 是否真的往日志里落了消息；关掉它来模拟"会话未激活"。 */
  promptLands = true
  async promptSession(sessionId: string, text: string): Promise<{ ok: boolean; reason?: string }> {
    this.prompts.push({ sessionId, text })
    if (this.promptVerdict.ok && this.promptLands) {
      this.messages = [...this.messages, { seq: 9000 + this.messages.length, role: 'user', text }]
    }
    return this.promptVerdict
  }
  promptVerdict: { ok: boolean; reason?: string } = { ok: true }
  async interruptTurn(): Promise<boolean> {
    this.interrupts++
    return true
  }
  async setDraft(text: string): Promise<boolean> {
    this.draft = text
    return true
  }
  getDraft(): string | null {
    return this.draft
  }
  registerCommand(spec: CommandSpec): void {
    this.commands.push(spec)
  }
  emit(type: string, payload: unknown): void {
    this.emitted.push({ type, payload })
  }
}

export const conversation = (): MessageLite[] => [
  { seq: 1, role: 'user', text: 'write a parser' },
  { seq: 2, role: 'assistant', text: 'sure', toolCalls: [{ name: 'write', path: 'src/parser.ts', write: true }] },
  { seq: 3, role: 'user', text: 'now add tests' },
  { seq: 4, role: 'assistant', text: 'ok', toolCalls: [{ name: 'bash', shell: true }] },
]

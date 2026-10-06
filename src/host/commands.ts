// Slash commands: /rewind, /rewind-undo, /rewind-history, /rewind-export-clean.
//
// The formatters are pure so their output can be tested without a harness; the
// registration is best-effort — if the harness exposes no command registry the
// plugin keeps working through the UI and the API.

import { formatImpact } from './export.js'
import type { HistoryEntry, RewindCandidate, UndoGrade } from '../core/types.js'
import type { HarnessAdapter } from './adapter.js'
import type { RewindController } from './hooks.js'

export function formatCandidates(candidates: readonly RewindCandidate[]): string {
  if (candidates.length === 0) return 'Nothing to rewind to yet: no user turns in this session.'
  return candidates
    .map((candidate) => `${candidate.ordinal}. #${candidate.seq}  ${candidate.preview}`)
    .join('\n')
}

export function formatHistory(history: readonly HistoryEntry[]): string {
  if (history.length === 0) return 'No rewind history yet.'
  return history
    .map((entry) => {
      const target = entry.targetSeq === null ? '-' : `#${entry.targetSeq}`
      const undoable = entry.reversible ? 'undoable' : 'not undoable'
      return `- ${entry.kind.padEnd(7)} ${target.padEnd(6)} ${undoable}`
    })
    .join('\n')
}

export function formatUndo(result: { grade: UndoGrade['grade']; reason?: string; divergentTurns?: number; notice?: string }): string {
  if (result.grade === 'clean') return 'Undone: the hidden turns are back.'
  if (result.grade === 'dirty') {
    return `Confirm: ${result.notice ?? 'the session moved on'}. Re-run with --force to undo anyway.`
  }
  if (result.grade === 'irreversible') {
    return `Cannot undo: ${result.reason ?? 'this rewind cannot be reversed'}.`
  }
  return `Nothing to undo${result.reason ? ` (${result.reason})` : ''}.`
}

export function registerCommands(
  adapter: HarnessAdapter,
  controller: RewindController,
  registry?: unknown,
): void {
  adapter.registerCommand({
    name: 'rewind',
    description: 'List rewind targets, or rewind to one by ordinal/seq.',
    handler: async (args) => {
      const sessionId = adapter.sessionId()
      const trimmed = args.trim()

      if (trimmed.length === 0) return formatCandidates(controller.candidates(sessionId))

      const ordinal = Number(trimmed.replace(/^#/, ''))
      const candidates = controller.candidates(sessionId)
      const chosen = Number.isFinite(ordinal)
        ? candidates.find((candidate) => candidate.ordinal === ordinal || candidate.seq === ordinal)
        : undefined
      if (!chosen) return `No rewind target matching "${trimmed}". Run /rewind to list them.`

      const result = await controller.mark({ sessionId, targetSeq: chosen.seq })
      if (!result.ok) return `Rewind failed: ${result.reason}`
      const impact = controller.impact(sessionId, chosen.seq)
      const preview = impact ? `\n${formatImpact(impact)}` : ''
      return `Rewinding to #${chosen.seq}. Send the prefilled draft to confirm, or cancel it.${preview}`
    },
  }, registry)

  adapter.registerCommand({
    name: 'rewind-undo',
    description: 'Undo the last rewind (add --force when the session moved on).',
    handler: async (args) => {
      const result = await controller.undo({
        sessionId: adapter.sessionId(),
        ...(args.includes('--force') ? { force: true } : {}),
      })
      return formatUndo(result)
    },
  }, registry)

  adapter.registerCommand({
    name: 'rewind-history',
    description: 'Show this session\'s rewind history.',
    handler: async () => formatHistory(controller.state(adapter.sessionId()).history),
  }, registry)

  adapter.registerCommand({
    name: 'rewind-export-clean',
    description: 'Export the transcript with rewound turns removed (and say what was removed).',
    handler: async () => {
      const sessionId = adapter.sessionId()
      const view = controller.state(sessionId)
      const { buildCleanExport } = await import('./export.js')
      return buildCleanExport(adapter.messagesOf(), view.ranges)
    },
  })
}

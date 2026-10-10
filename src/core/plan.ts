// Pure planning: given the visible messages and a target seq, say exactly what
// a rewind would take away — turns, files, shell calls we cannot undo.

import type { ImpactPlan, MessageLite, RewindCandidate } from './types.js'

const PREVIEW_MAX = 80

/** Collapse whitespace and cap length so previews stay one line in the UI. */
export function normalizePreview(text: string, max: number = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function kindOf(message: MessageLite): ImpactPlan['turns'][number]['kind'] {
  if (message.steering) return 'steering'
  if (message.role === 'user') return 'user'
  if (message.role === 'assistant') return 'assistant'
  return 'other'
}

/**
 * Rewind targets for `/rewind`: user turns, newest first (that is what people
 * reach for), each carrying a stable 1-based ordinal for keyboard navigation.
 */
export function listCandidates(messages: readonly MessageLite[], limit = 20): RewindCandidate[] {
  // Steering messages are user turns too: rewinding to an interruption is
  // exactly the "take that stop back" case people ask for.
  const userTurns = messages.filter((message) => message.role === 'user')
  const ordinalOf = new Map(userTurns.map((message, index) => [message.seq, index + 1]))
  return userTurns
    .slice(-limit)
    .reverse()
    .map((message) => ({
      seq: message.seq,
      ...(message.id === undefined ? {} : { id: message.id }),
      preview: normalizePreview(message.text),
      ordinal: ordinalOf.get(message.seq) ?? 0,
    }))
}

export interface PlanOptions {
  /** Disk probe; when it reports false the file will be recreated, not restored. */
  existing?: (path: string) => boolean
}

export function planRewind(
  messages: readonly MessageLite[],
  targetSeq: number,
  options: PlanOptions = {},
): ImpactPlan {
  const inRange = messages.filter((message) => message.seq >= targetSeq).sort((a, b) => a.seq - b.seq)

  const turns = inRange.map((message) => ({
    seq: message.seq,
    preview: normalizePreview(message.text),
    kind: kindOf(message),
  }))

  const files: ImpactPlan['files'] = []
  const seen = new Map<string, number>()
  let shellCalls = 0

  for (const message of inRange) {
    for (const call of message.toolCalls ?? []) {
      if (call.shell) shellCalls++
      if (!call.write || !call.path) continue
      const exists = options.existing ? options.existing(call.path) : true
      const entry: ImpactPlan['files'][number] = {
        path: call.path,
        action: exists ? 'restore' : 'recreate',
        detail: call.name,
      }
      const index = seen.get(call.path)
      if (index === undefined) {
        seen.set(call.path, files.length)
        files.push(entry)
      } else {
        // Newest write wins: that is the state the restore engine must reach.
        files[index] = entry
      }
    }
  }

  return { targetSeq, turns, files, shellCalls }
}

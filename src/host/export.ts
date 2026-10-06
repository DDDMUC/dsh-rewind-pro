// Clean export + impact formatting.
//
// A "clean" transcript is not a lie: it drops the rewound turns but says what
// was dropped, so an exported conversation never pretends the model never saw
// (or said) those things.

import type { HiddenRange, ImpactPlan, MessageLite } from '../core/types.js'

export function formatImpact(impact: ImpactPlan): string {
  const lines = [
    `${impact.turns.length} turns will be withdrawn (from #${impact.targetSeq}):`,
    ...impact.turns.map((turn) => `  - #${turn.seq} ${turn.kind}: ${turn.preview}`),
  ]

  if (impact.files.length > 0) {
    lines.push(`${impact.files.length} file(s) will be restored:`)
    for (const file of impact.files) lines.push(`  - ${file.path} (${file.action})`)
  }

  if (impact.shellCalls > 0) {
    lines.push(
      `Honest note: ${impact.shellCalls} shell/command call(s) happened in this range. ` +
        'Rewinding cannot undo their side effects.',
    )
  }

  return lines.join('\n')
}

export interface CleanExportOptions {
  title?: string
  now?: () => number
}

export function buildCleanExport(
  messages: readonly MessageLite[],
  ranges: readonly HiddenRange[],
  options: CleanExportOptions = {},
): string {
  const hidden = (seq: number): boolean => ranges.some((range) => seq >= range.start && seq <= range.end)
  const visible = messages.filter((message) => !hidden(message.seq))
  const removed = messages.length - visible.length

  const header = options.title ?? '# Clean transcript'
  const lines: string[] = [header, '']

  if (removed > 0) {
    const described = ranges.map((range) => `${range.start}-${range.end}`).join(', ')
    lines.push(`Removed ${removed} turns hidden by rewind (seq ${described}).`, '')
  }

  for (const message of visible) {
    lines.push(`## ${message.role} #${message.seq}`, '', message.text, '')
  }

  return lines.join('\n').trimEnd()
}

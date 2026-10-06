// Language follows the host, then the session, then English.
// navigator.language is deliberately NOT consulted: a browser locale says
// nothing about which language the operator chose for the harness.

export type Lang = 'zh' | 'en'

const STRINGS = {
  en: {
    rewind: 'Rewind to here',
    rewindShort: 'Rewind',
    cancel: 'Cancel rewind',
    confirmHint: 'Send the prefilled message to confirm, or cancel to keep the conversation.',
    pending: 'Rewinding to this turn — send to confirm',
    hiddenPill: (count: number) => `${count} turns hidden`,
    undo: 'Undo rewind',
    undoClean: 'Undo this rewind?',
    undoDirty: (turns: number) =>
      `${turns} new turns were written after this rewind. Undoing will splice them into a history the model never saw.`,
    undoIrreversible: 'This rewind cannot be undone on this harness. You can still read what was hidden.',
    history: 'Rewind history',
    historyEmpty: 'No rewinds yet.',
    jump: 'Jump here',
    candidates: 'Rewind to…',
    candidatesEmpty: 'No user turns to rewind to.',
    impactTurns: (count: number) => `${count} turns will be withdrawn`,
    impactFiles: (count: number) => `${count} file(s) will be restored`,
    shellNote: (count: number) => `${count} shell call(s) in this range cannot be undone.`,
    strategy: 'Strategy',
    strategyDerive: 'derive-patch — reversible',
    strategySurface: 'surface-op — not reversible',
    strategyUiOnly: 'ui-only — this view only',
    settings: 'Rewind',
    close: 'Close',
  },
  // Not `as const`: the two bundles must share one structural type so a new
  // key added to only one of them is a type error, not a runtime surprise.
  zh: {
    rewind: '回退到此处',
    rewindShort: '回退',
    cancel: '取消回退',
    confirmHint: '发送已填入的内容以确认，或取消以保留当前对话。',
    pending: '正在回退到这一轮 —— 发送以确认',
    hiddenPill: (count: number) => `已隐藏 ${count} 轮`,
    undo: '撤销回退',
    undoClean: '撤销这次回退？',
    undoDirty: (turns: number) => `这次回退之后又写入了 ${turns} 轮。撤销会把它们插入到模型从未见过的历史中。`,
    undoIrreversible: '当前宿主无法撤销这次回退，你仍可只读查看被隐藏的内容。',
    history: '回退历史',
    historyEmpty: '还没有回退记录。',
    jump: '跳到这里',
    candidates: '回退到…',
    candidatesEmpty: '没有可回退的用户轮次。',
    impactTurns: (count: number) => `将撤回 ${count} 轮`,
    impactFiles: (count: number) => `将还原 ${count} 个文件`,
    shellNote: (count: number) => `该区间内有 ${count} 次 shell 调用无法撤销。`,
    strategy: '遮蔽策略',
    strategyDerive: 'derive-patch —— 可逆',
    strategySurface: 'surface-op —— 不可逆',
    strategyUiOnly: 'ui-only —— 仅本视图',
    settings: '回退',
    close: '关闭',
  },
}

export type Strings = typeof STRINGS.en

/**
 * Host wins, session second, English last. Accepts anything (BCP-47 tags,
 * undefined) and only ever returns one of the two bundles we ship.
 */
export function pickLanguage(hostLanguage?: string | null, sessionLanguage?: string | null): Lang {
  for (const candidate of [hostLanguage, sessionLanguage]) {
    if (!candidate) continue
    const lower = candidate.toLowerCase()
    if (lower.startsWith('zh') || lower.includes('hans') || lower.includes('cn')) return 'zh'
    if (lower.startsWith('en')) return 'en'
  }
  return 'en'
}

export function strings(lang: Lang): Strings {
  return STRINGS[lang]
}

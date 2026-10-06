// History panel: every rewind ever made in this session, with jump and undo.
// Undo is graded host-side; here we only show what the grade means.

import * as React from 'react'
import { IconClose } from './icons.js'
import type { HistoryEntry } from '../core/types.js'
import type { Strings } from './locales.js'

export interface HistoryPanelProps {
  history: HistoryEntry[]
  onJump: (index: number) => void
  onUndo: (opId: string) => void
  onClose: () => void
  text: Strings
}

export function HistoryPanel({ history, onJump, onUndo, onClose, text }: HistoryPanelProps): React.ReactElement {
  return (
    <div className="dsh-rewind-pro-panel" role="dialog" aria-label={text.history}>
      <div className="dsh-rewind-pro-row" style={{ justifyContent: 'space-between' }}>
        <strong>{text.history}</strong>
        <button type="button" onClick={onClose} aria-label={text.close}>
          <IconClose />
        </button>
      </div>

      {history.length === 0 ? (
        <p className="dsh-rewind-pro-muted">{text.historyEmpty}</p>
      ) : (
        <ul className="dsh-rewind-pro-list">
          {history.map((entry, index) => (
            <li key={entry.opId} aria-selected="false">
              <span>
                #{index + 1} {entry.kind}
                {entry.targetSeq !== null ? ` · turn ${entry.targetSeq}` : ''}
                {!entry.reversible ? ` · ${text.strategySurface}` : ''}
              </span>
              <span className="dsh-rewind-pro-row">
                <button type="button" onClick={() => onJump(index)}>
                  {text.jump}
                </button>
                {entry.kind === 'commit' && entry.reversible && (
                  <button type="button" onClick={() => onUndo(entry.opId)}>
                    {text.undo}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

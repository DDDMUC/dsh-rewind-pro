// The pill that says "N turns hidden" with an undo action. Shown whenever the
// session has committed rewinds, so a hidden tail is never invisible.

import * as React from 'react'
import { IconUndo } from './icons.js'
import type { Strings } from './locales.js'

export interface CollapsedPillProps {
  hiddenTurns: number
  canUndo: boolean
  onUndo: () => void
  onOpenHistory: () => void
  text: Strings
}

export function CollapsedPill({ hiddenTurns, canUndo, onUndo, onOpenHistory, text }: CollapsedPillProps): React.ReactElement | null {
  if (hiddenTurns <= 0) return null
  return (
    <div className="dsh-rewind-pro-pill" role="status">
      <button type="button" onClick={onOpenHistory} style={{ background: 'none', border: 0, cursor: 'pointer', color: 'inherit', padding: 0 }}>
        {text.hiddenPill(hiddenTurns)}
      </button>
      {canUndo ? (
        <button type="button" onClick={onUndo} title={text.undo} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <IconUndo />
          {text.undo}
        </button>
      ) : (
        <span className="dsh-rewind-pro-muted">{text.undoIrreversible}</span>
      )}
    </div>
  )
}

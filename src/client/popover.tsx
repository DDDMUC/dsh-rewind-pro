// Impact popover: before anything is committed the user sees exactly what will
// be withdrawn — turns, files, and an honest note about shell calls.

import * as React from 'react'
import type { ImpactPlan } from '../core/types.js'
import type { Strings } from './locales.js'

export interface PopoverProps {
  impact: ImpactPlan | null
  onConfirm: () => void
  onCancel: () => void
  text: Strings
  /** Blocks the confirm button when undo will be impossible. */
  irreversible?: boolean
}

export function ImpactPopover({ impact, onConfirm, onCancel, text, irreversible }: PopoverProps): React.ReactElement | null {
  if (!impact) return null
  return (
    <div className="dsh-rewind-pro-popover" role="dialog" aria-label={text.rewind}>
      <strong>{text.impactTurns(impact.turns.length)}</strong>
      <ul className="dsh-rewind-pro-list">
        {impact.turns.map((turn) => (
          <li key={turn.seq} aria-selected="false">
            <span>
              #{turn.seq} · {turn.kind}
            </span>
            <span className="dsh-rewind-pro-muted">{turn.preview}</span>
          </li>
        ))}
      </ul>

      {impact.files.length > 0 && (
        <>
          <div style={{ marginTop: 8 }}>{text.impactFiles(impact.files.length)}</div>
          <ul className="dsh-rewind-pro-list">
            {impact.files.map((file) => (
              <li key={file.path} aria-selected="false">
                <span>{file.path}</span>
                <span className="dsh-rewind-pro-muted">{file.action}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {impact.shellCalls > 0 && <div className="dsh-rewind-pro-danger" style={{ marginTop: 8 }}>{text.shellNote(impact.shellCalls)}</div>}
      {irreversible && <div className="dsh-rewind-pro-danger" style={{ marginTop: 8 }}>{text.undoIrreversible}</div>}

      <div className="dsh-rewind-pro-row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel}>
          {text.cancel}
        </button>
        <button type="button" onClick={onConfirm}>
          {text.rewindShort}
        </button>
      </div>
    </div>
  )
}

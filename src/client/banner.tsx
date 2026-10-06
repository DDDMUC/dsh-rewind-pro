// Pending banner: while a rewind is armed the user must always see it and must
// always have a way out. Cancelling restores the draft the rewind replaced.

import * as React from 'react'
import { IconClose, IconRewind } from './icons.js'
import type { Strings } from './locales.js'

export interface BannerProps {
  targetSeq: number | null
  onCancel: () => void
  text: Strings
}

export function PendingBanner({ targetSeq, onCancel, text }: BannerProps): React.ReactElement | null {
  if (targetSeq === null) return null
  return (
    <div className="dsh-rewind-pro-banner" role="alert">
      <IconRewind />
      <span>{text.pending}</span>
      <span className="dsh-rewind-pro-muted">{text.confirmHint}</span>
      <button type="button" onClick={onCancel} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <IconClose />
        {text.cancel}
      </button>
    </div>
  )
}

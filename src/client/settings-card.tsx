// Settings card: read-only truth about what this harness can do and which
// strategy is in effect. The knobs live in cordis.patch.yml (profile config),
// so the UI explains instead of pretending to persist anything.

import * as React from 'react'
import type { Capability } from '../core/types.js'
import type { Strings } from './locales.js'

export interface SettingsCardProps {
  capability: Capability
  snapshotEnabled: boolean
  trackSubagent: boolean
  text: Strings
}

export function SettingsCard({ capability, snapshotEnabled, trackSubagent, text }: SettingsCardProps): React.ReactElement {
  const label =
    capability.chosen === 'derive-patch'
      ? text.strategyDerive
      : capability.chosen === 'surface-op'
        ? text.strategySurface
        : text.strategyUiOnly

  return (
    <div className="dsh-rewind-pro-panel" role="group" aria-label={text.settings}>
      <strong>{text.settings}</strong>
      <ul className="dsh-rewind-pro-list">
        <li aria-selected="false">
          <span>{text.strategy}</span>
          <span className="dsh-rewind-pro-muted">{label}</span>
        </li>
        <li aria-selected="false">
          <span>DSH</span>
          <span className="dsh-rewind-pro-muted">{capability.dshVersion}</span>
        </li>
        <li aria-selected="false">
          <span>workspace snapshots</span>
          <span className="dsh-rewind-pro-muted">{snapshotEnabled ? 'on' : 'off'}</span>
        </li>
        <li aria-selected="false">
          <span>subagent edits</span>
          <span className="dsh-rewind-pro-muted">{trackSubagent ? 'tracked' : 'ignored'}</span>
        </li>
      </ul>
    </div>
  )
}

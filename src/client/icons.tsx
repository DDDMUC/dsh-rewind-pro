// Hand-drawn 16px SVG icons: no icon font, no icon library, no network fetch.
// They inherit currentColor so light/dark themes need no extra work.

import * as React from 'react'

const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function IconRewind(): React.ReactElement {
  return (
    <svg {...base}>
      <path d="M3 4v8" />
      <path d="M3 8h7a3.2 3.2 0 1 1-3.2 3.2" />
      <path d="M6.4 5.2 3.2 8l3.2 2.8" />
    </svg>
  )
}

export function IconUndo(): React.ReactElement {
  return (
    <svg {...base}>
      <path d="M6 4.5 3.5 7 6 9.5" />
      <path d="M3.5 7h6a3.2 3.2 0 0 1 0 6.4H7" />
    </svg>
  )
}

export function IconClose(): React.ReactElement {
  return (
    <svg {...base}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

export function IconHistory(): React.ReactElement {
  return (
    <svg {...base}>
      <path d="M8 4.2V8l2.6 1.6" />
      <circle cx="8" cy="8" r="5.2" />
    </svg>
  )
}

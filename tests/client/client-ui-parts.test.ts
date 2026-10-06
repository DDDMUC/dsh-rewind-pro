// Pure UI helpers: language resolution and candidate-list keyboard navigation.

import { describe, expect, it } from 'vitest'
import { clampSelection, moveSelection } from '../../src/client/candidates'
import { pickLanguage, strings } from '../../src/client/locales'
import { CSS } from '../../src/client/styles'

describe('pickLanguage', () => {
  it('follows the host language first', () => {
    expect(pickLanguage('en-US', 'zh-CN')).toBe('en')
    expect(pickLanguage('zh-Hans', 'en')).toBe('zh')
  })

  it('falls back to the session language', () => {
    expect(pickLanguage(undefined, 'zh')).toBe('zh')
    expect(pickLanguage(null, 'en-GB')).toBe('en')
  })

  it('defaults to English and never invents a locale', () => {
    expect(pickLanguage()).toBe('en')
    expect(pickLanguage('fr-FR')).toBe('en')
  })

  it('ships the same keys in both bundles', () => {
    expect(Object.keys(strings('en')).sort()).toEqual(Object.keys(strings('zh')).sort())
  })
})

describe('candidate navigation', () => {
  it('starts at the first candidate when moving down from nothing', () => {
    expect(moveSelection({ index: -1, count: 3 }, 1)).toBe(0)
  })

  it('wraps around both ends', () => {
    expect(moveSelection({ index: 2, count: 3 }, 1)).toBe(0)
    expect(moveSelection({ index: 0, count: 3 }, -1)).toBe(2)
  })

  it('has no selection when the list is empty', () => {
    expect(moveSelection({ index: 0, count: 0 }, 1)).toBe(-1)
    expect(clampSelection(3, 0)).toBe(-1)
  })

  it('clamps into range', () => {
    expect(clampSelection(9, 3)).toBe(2)
    expect(clampSelection(-4, 3)).toBe(0)
  })
})

describe('styles', () => {
  it('uses harness design tokens rather than hardcoded colours', () => {
    expect(CSS).toContain('--dsw-alias-')
    expect(CSS).not.toContain('tailwind')
  })
})

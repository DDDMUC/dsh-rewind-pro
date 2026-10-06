// Draft stash: a rewind overwrites the composer with the target text. Whatever
// the user had typed must come back if the rewind is cancelled — and must not
// survive into the next session.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDraftStash } from '../../src/client/draft-stash'

beforeEach(() => sessionStorage.clear())
afterEach(() => sessionStorage.clear())

describe('draft stash', () => {
  it('returns the stashed text once and then forgets it', () => {
    const stash = createDraftStash('s1')
    stash.stash('half-typed thought')
    expect(stash.take()).toBe('half-typed thought')
    expect(stash.take()).toBeNull()
  })

  it('keeps drafts per session', () => {
    createDraftStash('s1').stash('for s1')
    expect(createDraftStash('s2').take()).toBeNull()
    expect(createDraftStash('s1').take()).toBe('for s1')
  })

  it('does not stash an empty draft', () => {
    const stash = createDraftStash('s1')
    stash.stash('   ')
    expect(stash.take()).toBeNull()
  })

  it('survives a storage failure instead of throwing into the UI', () => {
    // Storage is injected, so "storage is broken" is testable for real.
    const broken = {
      getItem: () => {
        throw new Error('quota')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('quota')
      },
    } as unknown as Storage

    const stash = createDraftStash('s1', broken)
    expect(() => stash.stash('x')).not.toThrow()
    expect(stash.take()).toBeNull()
    expect(() => stash.clear()).not.toThrow()
  })
})

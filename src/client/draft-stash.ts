// Draft stash: when a rewind starts it replaces the composer content with the
// target text. Whatever the user was typing is kept here so a cancel can put it
// back. Session-scoped, best-effort: storage failures must never break the UI.

const KEY = (sessionId: string): string => `dsh-rewind-pro:draft:${sessionId}`

export interface DraftStash {
  stash: (text: string) => void
  take: () => string | null
  peek: () => string | null
  clear: () => void
}

const safeStorage = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function createDraftStash(sessionId: string, storage: Storage | null = safeStorage()): DraftStash {
  const key = KEY(sessionId)

  return {
    stash(text) {
      if (!storage || text.trim().length === 0) return
      try {
        storage.setItem(key, text)
      } catch {
        /* quota or disabled storage: the draft is simply not recoverable */
      }
    },

    /** Read once and forget: a stash must not resurrect an old draft later. */
    take() {
      if (!storage) return null
      try {
        const value = storage.getItem(key)
        if (value === null) return null
        storage.removeItem(key)
        return value
      } catch {
        return null
      }
    },

    peek() {
      if (!storage) return null
      try {
        return storage.getItem(key)
      } catch {
        return null
      }
    },

    clear() {
      if (!storage) return
      try {
        storage.removeItem(key)
      } catch {
        /* ignore */
      }
    },
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { useSafeLocalStorage } from '../../app/composables/useSafeLocalStorage'

vi.mock('@vueuse/core', () => ({ useLocalStorage: vi.fn() }))

describe('embedded preferences with unavailable browser storage', () => {
  beforeEach(() => { vi.mocked(useLocalStorage).mockReset() })
  it('keeps reactive state usable when the browser denies storage access', () => {
    vi.mocked(useLocalStorage).mockImplementation(() => { throw new DOMException('Access denied', 'SecurityError') })
    const drafts = useSafeLocalStorage<Record<string, string>>('drafts', {})
    drafts.value.channel = 'Unsent draft'
    expect(drafts.value.channel).toBe('Unsent draft')
  })
  it('preserves the persistent ref when browser storage is available', () => {
    const saved = ref('saved draft')
    vi.mocked(useLocalStorage).mockReturnValue(saved)
    expect(useSafeLocalStorage('draft', '')).toBe(saved)
  })
  it('does not conceal unrelated construction errors', () => {
    vi.mocked(useLocalStorage).mockImplementation(() => { throw new TypeError('Invalid serializer') })
    expect(() => useSafeLocalStorage('draft', '')).toThrow('Invalid serializer')
  })
})

import { describe, expect, it } from 'vitest'
import { emojiByName, emojiCategories, isJumboEmoji, replaceShortcodes, searchEmoji } from '../../shared/emoji'

describe('emoji', () => {
  it('has unique shortcodes', () => {
    const names = emojiCategories().flatMap(category => category.emoji.map(entry => entry.name))
    expect(new Set(names).size).toBe(names.length)
  })

  it('ranks exact and prefix shortcode matches first', () => {
    expect(searchEmoji('thumbsup')[0]?.emoji).toBe('👍')
    expect(searchEmoji('fire')[0]?.emoji).toBe('🔥')
    expect(searchEmoji('party').map(entry => entry.emoji)).toContain('🎉')
    expect(searchEmoji('')).toEqual([])
  })

  it('replaces known shortcodes outside code', () => {
    expect(replaceShortcodes('ship it :rocket: `:rocket:` :nope:')).toBe('ship it 🚀 `:rocket:` :nope:')
    expect(emojiByName('HEART')?.emoji).toBe('❤️')
  })

  it('makes short emoji-only messages jumbo', () => {
    expect(isJumboEmoji('🎉')).toBe(true)
    expect(isJumboEmoji('👍🏽 🏳️‍🌈 ❤️')).toBe(true)
    expect(isJumboEmoji('nice 🎉')).toBe(false)
    expect(isJumboEmoji('123')).toBe(false)
    expect(isJumboEmoji('🎉'.repeat(28))).toBe(false)
  })
})

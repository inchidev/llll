import { describe, expect, it } from 'vitest'
import { threadTitle } from '../../shared/threads'

describe('threadTitle', () => {
  it('uses normalized parent message content', () => {
    expect(threadTitle('  shipping   update\nfor today  ')).toBe('shipping update for today')
  })

  it('falls back to attachment context', () => {
    expect(threadTitle('', ['brief.pdf'])).toBe('brief.pdf')
    expect(threadTitle('', ['one.png', 'two.png'])).toBe('2 attachments')
    expect(threadTitle('', [])).toBe('Thread')
  })

  it('keeps titles within the channel name limit', () => {
    expect(threadTitle('x'.repeat(120))).toHaveLength(80)
    expect(threadTitle('x'.repeat(120)).endsWith('…')).toBe(true)
  })
})

it('resolves mentions before shortening thread titles and hides unknown raw IDs', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  expect(threadTitle(`<@${id}> Reply with evidence`, [], { [id]: 'Pi' })).toBe('@Pi Reply with evidence')
  expect(threadTitle(`<@${id}> Reply`)).toBe('@Member Reply')
})

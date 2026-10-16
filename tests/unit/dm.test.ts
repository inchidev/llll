import { describe, expect, it } from 'vitest'
import { canAccessAgentConversation, dmTitle } from '../../shared/dm'
import { formatBytes } from '../../shared/format'

describe('dmTitle', () => {
  const users = [
    { id: '1', displayName: 'Ada', avatarR2Key: null },
    { id: '2', displayName: 'Bob', avatarR2Key: null },
    { id: '3', displayName: 'Cara', avatarR2Key: null },
    { id: '4', displayName: 'Dan', avatarR2Key: null },
  ]
  it('uses explicit name', () => {
    expect(dmTitle('Core', users, '1')).toBe('Core')
  })
  it('treats placeholder dm as unnamed', () => {
    expect(dmTitle('dm', users.slice(0, 2), '1')).toBe('Bob')
  })
  it('1:1 uses the other person', () => {
    expect(dmTitle(null, users.slice(0, 2), '1')).toBe('Bob')
  })
  it('group lists names then others', () => {
    expect(dmTitle(null, users, '1')).toBe('Bob, Cara, Dan')
  })
})

describe('formatBytes', () => {
  it('formats kilobytes', () => {
    expect(formatBytes(2048)).toBe('2 KB')
  })
})

describe('canAccessAgentConversation', () => {
  it('lets a participating Agent stream replies into its inherited DM thread', () => {
    expect(canAccessAgentConversation('agent', false, true)).toBe(true)
  })

  it('keeps an Agent DM hidden from ordinary human members', () => {
    expect(canAccessAgentConversation('human', false, true)).toBe(false)
  })

  it('lets workspace managers open Agent DMs', () => {
    expect(canAccessAgentConversation('human', true, true)).toBe(true)
  })
})

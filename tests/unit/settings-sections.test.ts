import { describe, expect, it } from 'vitest'
import { connectionsTabFor } from '../../app/utils/settings-sections'

describe('old addresses of what is now Connections', () => {
  it('opens the tab each one became', () => {
    expect(connectionsTabFor('shortcut', false)).toBe('shortcut')
    expect(connectionsTabFor('mcp', true)).toBe('tokens')
  })
  it('keeps Access tokens to the Owner', () => {
    expect(connectionsTabFor('mcp', false)).toBeNull()
  })
  it('leaves every other section alone, including Connections itself', () => {
    expect(connectionsTabFor('connections', true)).toBeNull()
    expect(connectionsTabFor('agent', true)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { serverAddressFromCode } from '../../packages/native-shell/server-list'

describe('a scanned Server code', () => {
  it('keeps only the origin of a link to any page', () => {
    expect(serverAddressFromCode(' https://chat.example.com/channels/1?x=1 ')).toBe('https://chat.example.com')
  })
  it('leaves an address without a scheme for the usual check', () => {
    expect(serverAddressFromCode('chat.example.com')).toBe('chat.example.com')
  })
})

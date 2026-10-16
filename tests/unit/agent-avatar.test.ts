import { describe, expect, it } from 'vitest'
import { agentAvatarSources, agentAvatarSrc, userAvatarSrc } from '../../app/utils/agent-avatar'
import { centerSquare } from '../../app/utils/avatar-image'
import { isStoredAvatarKey } from '../../shared/avatar'

describe('agent avatars', () => {
  it('assigns an included avatar deterministically', () => {
    const first = agentAvatarSrc('agent-123')

    expect(agentAvatarSources).toContain(first)
    expect(agentAvatarSrc('agent-123')).toBe(first)
  })

  it('only supplies generated avatars for agents', () => {
    expect(userAvatarSrc({ id: 'agent-1', kind: 'agent' })).toMatch(/^\/avatars\/agents\/.+\.png$/)
    expect(userAvatarSrc({ id: 'human-1', kind: 'human' })).toBeUndefined()
    expect(userAvatarSrc({ id: 'human-1', kind: 'human', avatarR2Key: null })).toBeUndefined()
  })
})

describe('uploaded avatars', () => {
  it('serves uploaded human avatars through a key-versioned path', () => {
    expect(userAvatarSrc({ id: 'human-1', kind: 'human', avatarR2Key: 'main/users/human-1/avatar-a.webp' }))
      .toBe('/api/users/human-1/avatar?v=main%2Fusers%2Fhuman-1%2Favatar-a.webp')
  })

  it('keeps the agent avatar endpoint for uploaded agent pictures', () => {
    expect(userAvatarSrc({ id: 'agent-1', kind: 'agent', avatarR2Key: 'main/agents/agent-1/avatar-a.png' }))
      .toMatch(/^\/api\/workspaces\/main\/agents\/agent-1\/avatar\?v=/)
  })

  it('ignores remote provider pictures the image policy would block', () => {
    expect(isStoredAvatarKey('https://avatars.githubusercontent.com/u/1')).toBe(false)
    expect(isStoredAvatarKey('data:image/png;base64,AAAA')).toBe(false)
    expect(isStoredAvatarKey('main/users/u/avatar-a.webp')).toBe(true)
    expect(isStoredAvatarKey(null)).toBe(false)
    expect(userAvatarSrc({ id: 'human-1', kind: 'human', avatarR2Key: 'https://example.com/a.png' })).toBeUndefined()
  })

  it('crops to the largest centered square', () => {
    expect(centerSquare(800, 600)).toEqual({ x: 100, y: 0, size: 600 })
    expect(centerSquare(300, 500)).toEqual({ x: 0, y: 100, size: 300 })
    expect(centerSquare(256, 256)).toEqual({ x: 0, y: 0, size: 256 })
  })
})

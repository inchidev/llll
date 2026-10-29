import { beforeEach, expect, it, vi } from 'vitest'
import { Permission } from '../../shared/permissions'

const actor = vi.hoisted(() => ({ value: { isOwner: false, perms: 0, user: { id: 'member' } } }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async () => actor.value }))
vi.stubGlobal('getRouterParam', () => 'server')
const { providerManager } = await import('../../server/utils/agent-provider-access')
const event = {} as never
beforeEach(() => { actor.value = { isOwner: false, perms: Number(Permission.useAgents), user: { id: 'member' } } })

it('lets a member manage only their own ChatGPT connection', async () => {
  const manager = await providerManager(event)
  expect(() => manager.require('chatgpt', null)).not.toThrow()
  expect(() => manager.require('chatgpt', { kind: 'chatgpt', name: 'Mine', enabled: true, models: [], connectedBy: 'member' })).not.toThrow()
  expect(() => manager.require('chatgpt', { kind: 'chatgpt', name: 'Theirs', enabled: true, models: [], connectedBy: 'other' })).toThrow(/another member/u)
  expect(() => manager.require('openrouter', null)).toThrow(/Only the owner/u)
})

it('keeps every provider with the owner and refuses members without Use agents', async () => {
  actor.value = { isOwner: true, perms: 0, user: { id: 'owner' } }
  expect(() => (async () => (await providerManager(event)).require('openrouter', { kind: 'chatgpt', name: 'Theirs', enabled: true, models: [], connectedBy: 'other' }))()).not.toThrow()
  actor.value = { isOwner: false, perms: 0, user: { id: 'member' } }
  await expect(providerManager(event)).rejects.toMatchObject({ statusCode: 403 })
})

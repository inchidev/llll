import { reactive, readonly } from 'vue'
import { describe, expect, it } from 'vitest'
import { authorizeResource, resourceAllowed, type AuthorizationContext } from '../../shared/authorization'
import { cloneResourceAccess, parseResourceAccess, resourceAccessWithin } from '../../shared/resource-access'
import { authorizeResourceRequest } from '../../server/utils/resource-policy'
import type { L4Env } from '../../workers/env'

function context(): AuthorizationContext {
  return { serverId: 'server', principal: { id: 'agent', kind: 'agent', roleId: 'researcher', roleName: 'Researcher', permissions: 0, isOwner: false,
    resourceAccess: { boards: ['board-public'], documents: ['document-public'], databases: ['database-public'] } }, credential: { kind: 'agent_runtime' } }
}

describe('resource authorization', () => {
  it('keeps allowed resources and rejects foreign resources even when the delegator is owner', () => {
    const auth = context()
    auth.delegation = { by: 'owner', isOwner: true, permissions: 0 }
    expect(resourceAllowed(auth, 'boards', 'board-public')).toBe(true)
    expect(() => authorizeResource(auth, 'boards', 'board-private')).toThrow('not granted')
  })

  it('intersects agent and delegator resource scopes', () => {
    const auth = context()
    auth.delegation = { by: 'member', resourceAccess: { boards: [] } }
    expect(resourceAllowed(auth, 'boards', 'board-public')).toBe(false)
  })

  it('fails closed on corrupt policy and prevents granting a broader policy', () => {
    expect(parseResourceAccess('{broken').boards).toEqual([])
    expect(parseResourceAccess('{"boards":"all"}').boards).toEqual([])
    expect(resourceAccessWithin({}, { boards: ['one'] })).toBe(false)
    expect(resourceAccessWithin({ boards: ['one'] }, { boards: ['one', 'two'] })).toBe(true)
    expect(resourceAccessWithin({ boards: ['private'] }, { boards: ['one'] })).toBe(false)
  })

  it('checks the owning table for direct record/field/view routes', async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ resourceId: 'database-private' }) }) }) } } as L4Env
    for (const collection of ['database-items', 'database-fields', 'database-views']) {
      await expect(authorizeResourceRequest(env, context(), `/api/${collection}/item-id`)).rejects.toThrow('not granted')
    }
    await expect(authorizeResourceRequest(env, context(), '/api/documents/document-private')).rejects.toThrow('not granted')
    await expect(authorizeResourceRequest(env, context(), '/api/documents/document-public')).resolves.toBeUndefined()
    await expect(authorizeResourceRequest(env, context(), '/api/servers/server/documents')).rejects.toThrow('not granted')
  })
})

it('clones reactive and readonly Role scopes without sharing mutable arrays', () => {
 const original = reactive({ projects: ['project-a'], boards: null, repositories: [] as string[] })
 for (const source of [original, readonly(original)]) {
  const copy = cloneResourceAccess(source)
  expect(copy).toEqual({ projects: ['project-a'], boards: null, repositories: [] })
  copy.projects!.push('project-b')
  copy.repositories!.push('repo')
  expect(original.projects).toEqual(['project-a'])
  expect(original.repositories).toEqual([])
 }
})

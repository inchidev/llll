import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { L4Env } from '../../workers/env'
import { agentRepositories, githubAgentClient } from '../../server/utils/github-agent-client'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const env = { GITHUB_AGENT_APP_ID: '4242', GITHUB_AGENT_APP_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() } as L4Env

describe('Workers GitHub App discovery transport', () => {
  function fixture(redirectAt?: string) {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.redirect).toBe('manual')
      const target = new URL(String(url))
      expect(target.origin).toBe('https://api.github.com')
      if (target.pathname === redirectAt) return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/token' } })
      if (target.pathname === '/app/installations') return Response.json([{ id: 101, suspended_at: null }, { id: 102, suspended_at: '2026-10-25' }])
      if (target.pathname === '/app/installations/101/access_tokens') {
        expect(JSON.parse(String(init?.body))).toEqual({ permissions: { metadata: 'read' } })
        return Response.json({ token: 'temporary-discovery-capability' })
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer temporary-discovery-capability')
      if (target.pathname === '/installation/repositories') return Response.json({ repositories: [
        { id: 11, full_name: 'source/project', fork: false, archived: false, default_branch: 'main' },
        { id: 12, full_name: 'source/archived', fork: false, archived: true, default_branch: 'main' },
      ] })
      if (target.pathname === '/installation/token') { expect(init?.method).toBe('DELETE'); return new Response(null, { status: 204 }) }
      throw Error('Unexpected operation')
    })
    return transport
  }
  it('discovers only active installations/repos and revokes its metadata-only credential', async () => {
    const transport = fixture()
    expect(await agentRepositories(env, transport)).toEqual([{ id: 11, name: 'source/project', installationId: 101, fork: false, defaultBranch: 'main' }])
    expect(transport).toHaveBeenCalledTimes(4)
  })
  it.each(['/app/installations', '/app/installations/101/access_tokens', '/installation/repositories', '/installation/token'])('does not follow credentialed redirects at %s', async path => {
    const transport = fixture(path)
    await expect(agentRepositories(env, transport)).rejects.toMatchObject({ statusCode: 502 })
    expect(transport.mock.calls.every(([url]) => new URL(String(url)).origin === 'https://api.github.com')).toBe(true)
    if (path === '/installation/repositories') expect(transport.mock.calls.some(([url]) => new URL(String(url)).pathname === '/installation/token')).toBe(true)
  })
  it('fails closed when a single-repository token endpoint redirects', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('manual')
      expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [11], permissions: { contents: 'read' } })
      return new Response(null, { status: 307, headers: { Location: 'http://169.254.169.254/' } })
    })
    await expect(githubAgentClient(env, { installationId: 101, repositoryId: 11, access: 'read' }, undefined, transport)).rejects.toMatchObject({ statusCode: 502 })
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

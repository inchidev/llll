import { expect, it, vi } from 'vitest'
import { cleanupClosedPreviews, closedPreviewResources, openPullRequests } from '../../scripts/preview-cleanup.mjs'

const open = [{ number: 433, branch: 'telegram-open-server-directly' }, { number: 422, branch: 'fix/calls-settings-off-cloudflare' }]

it('keeps main, open PRs and everything outside the Preview naming', () => {
  const previews = [{ id: '1', name: 'main' }, { id: '2', name: 'telegram-open-server-directly' }, { id: '3', name: 'claude/factory-section' }, { id: '4', name: 'release/0.3.7' }]
  const databases = ['llll', 'llll-main', 'llll-server-main', 'llll-pr-433', 'llll-server-pr-433', 'llll-server-pr-422-fresh', 'llll-pr-427', 'llll-server-pr-427', 'llll-server-pr-398-fresh',
    'llll-f4c27435-3c8a-4186-b82f-89c11e71dcf2-db', 'llll-server-staging-files', 'afterprompt-pr-claude-x', 'llll-server-pr-abc'].map((name, index) => ({ name, uuid: String(index) }))
  const result = closedPreviewResources({ open, previews, databases })
  expect(result.previews.map(p => p.name)).toEqual(['claude/factory-section', 'release/0.3.7'])
  expect(result.databases.map(d => d.name)).toEqual(['llll-pr-427', 'llll-server-pr-427', 'llll-server-pr-398-fresh'])
})

it('deletes through the account API, pages through lists and keeps going after one failure', async () => {
  const calls: string[] = []
  const page = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix}/${i}` }))
  const api = vi.fn(async (path: string, method = 'GET') => {
    calls.push(`${method} ${path}`)
    if (method === 'DELETE') { if (path.endsWith('/old0')) throw new Error('busy'); return null }
    if (path.startsWith('/workers/workers/llll-server/previews')) return /[?&]page=1$/.test(path) ? page('old', 100) : [{ id: 'm', name: 'main' }]
    if (path.startsWith('/workers/workers/llll/previews')) return []
    if (path.startsWith('/d1/database')) return [{ name: 'llll-server-pr-427', uuid: 'u1' }, { name: 'llll-server-pr-433', uuid: 'u2' }]
    throw new Error('unexpected ' + path)
  })
  const deleted = await cleanupClosedPreviews({ api, open, log: () => {} })
  expect(deleted.previews).toHaveLength(99)
  expect(deleted.failed).toEqual(['llll-server:old/0: busy'])
  expect(deleted.databases).toEqual(['llll-server-pr-427'])
  expect(calls).toContain('DELETE /d1/database/u1')
  expect(calls).not.toContain('DELETE /d1/database/u2')
  expect(calls).not.toContain('DELETE /workers/workers/llll-server/previews/m')
})

it('refuses to decide when GitHub does not answer cleanly', async () => {
  await expect(openPullRequests('inchidev/llll', vi.fn(async () => new Response('', { status: 403 })))).rejects.toThrow('403')
  await expect(openPullRequests('inchidev/llll', vi.fn(async () => Response.json([{ number: 1 }])))).rejects.toThrow('invalid PR')
  expect(await openPullRequests('inchidev/llll', vi.fn(async () => Response.json([{ number: 433, head: { ref: 'telegram-open-server-directly' } }])))).toEqual([open[0]])
})

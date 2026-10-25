import { DatabaseSync } from 'node:sqlite'
import { generateKeyPairSync } from 'node:crypto'
import { importSPKI, jwtVerify } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { createAgentRun, findAgentRun, runAuthorization  } from '../../server/utils/agent-run-service'
import { previousRunFiles, requireRunFiles } from '../../server/utils/agent-files'
import { createSchedule } from '../../server/utils/schedule-service'
import { publishCodeProposal, codeProposalChecks, codeRepositoryArchive } from '../../server/utils/agent-code-service'
import type { AgentRun } from '../../shared/agent-execution'
import type { CodeProposalInput } from '../../shared/code-environments'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKey = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const publicKey = await importSPKI(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'RS256')
const permissions = Permission.sendMessages | Permission.readTasks | Permission.executeTasks | Permission.useComputer | Permission.proposeCode
const baseSha = 'a'.repeat(40)
const baseTree = 'b'.repeat(40)
let db: DatabaseSync
let env: L4Env
let run: AgentRun
let head: string | null
let pr: Record<string, unknown> | null
let calls: Array<{ path: string; method: string; body: Record<string, unknown> }>
let minted: Array<{ repository_ids: number[]; permissions: Record<string, string> }>
let tokens: Map<string, { repository_ids: number[]; permissions: Record<string, string> }>
let sequence: number
let dropPrResponse: boolean
let lintSuccess: boolean
let archiveLocation: string
let archiveStatus: number
let archiveRedirectStatus: number
let archiveHook: (() => void) | undefined
let storedArchives: Map<string, Uint8Array>

const configuration = { name: 'Project', sourceRepo: 'source/project', sourceRepoId: 11, sourceInstallationId: 101,
  workRepo: 'worker/project', workRepoId: 22, workInstallationId: 202, baseBranch: 'main', requiredChecks: ['lint', 'build'], previewHosts: ['dev.llll.gg'] }
const input = (): CodeProposalInput => ({ title: 'Fix source behavior', body: 'Changes and reported validation.', files: [{ path: 'src/index.js', content: 'export const answer = 42\n', executable: false }] })
const count = (suffix: string, method = 'POST') => calls.filter(call => call.path.endsWith(suffix) && call.method === method).length
const currentPr = () => ({ ...pr, head: { ref: `l4-agent/${run.id}`, sha: head, repo: { id: 22 } }, base: { ref: 'main', repo: { id: 11 } } })

beforeEach(async () => {
  archiveLocation = `https://codeload.github.com/source/project/legacy.tar.gz/${baseSha}`
  archiveStatus = 200; archiveRedirectStatus = 302; archiveHook = undefined; storedArchives = new Map()
  head = null; pr = null; calls = []; minted = []; tokens = new Map(); sequence = 1; dropPrResponse = false; lintSuccess = false
  db = new DatabaseSync(':memory:')
  db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json) VALUES('owner-role','owner','Owner',0,'{}'),
      ('agent-role','custom:code','Coder',${permissions},'{"boards":["code-board"],"repositories":["11"]}');
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('owner-user','human','Owner','active','owner-role','2026-10-21'),('agent-user','agent','Coder','active','agent-role','2026-10-21');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Test','owner-user');
    INSERT INTO agents(user_id,created_by,harness) VALUES('agent-user','owner-user','pi');
    INSERT INTO channels(id,name,type,visibility) VALUES('code-channel','Code','text','server');
    INSERT INTO task_boards(id,name,created_by) VALUES('code-board','Code','owner-user');`)
  db.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('code-env', JSON.stringify(configuration), 'owner-user', '2026-10-21', '2026-10-21')
  db.exec("INSERT INTO tasks(id,board_id,title,description,status,priority,position,assignee_id,environment_id,created_by,created_at,updated_at) VALUES('code-task','code-board','Fix behavior','','ready','normal',1,'agent-user','code-env','owner-user','2026-10-21','2026-10-21')")
  env = { DB: d1(db), AUTH_SECRET: 'test-only-server-secret-with-32-characters', FILES: { get: vi.fn(async (key: string) => { const bytes = storedArchives.get(key); return bytes ? { size: bytes.length, body: new Blob([new Uint8Array(bytes)]).stream() } : null }), put: vi.fn(async (key: string, bytes: Uint8Array) => { storedArchives.set(key, bytes) }) }, AI: {},
    GITHUB_AGENT_APP_ID: '4242', GITHUB_AGENT_APP_PRIVATE_KEY: privateKey,
    AGENT_RUNNER_URL: 'http://runner', AGENT_RUNNER_TOKEN: 'runner-secret', AGENT_RUN_DO: { getByName: () => ({ wake: async () => {} }) } } as unknown as L4Env
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options: RequestInit = {}) => {
    const uri = new URL(String(url))
    // Workers supports manual/follow, but rejects redirect:'error'. Every credentialed hop is manual.
    expect(options.redirect).toBe('manual')
    if (uri.origin === 'https://codeload.github.com') {
      expect(new Headers(options.headers).has('Authorization')).toBe(false)
      expect(new Headers(options.headers).has('Cookie')).toBe(false)
      expect(options.credentials).toBe('omit')
      archiveHook?.()
      return new Response(archiveStatus === 200 ? 'archive-bytes' : null, { status: archiveStatus, headers: { Location: 'http://169.254.169.254/' } })
    }
    expect(uri.origin).toBe('https://api.github.com')
    const method = options.method ?? 'GET'
    const body = options.body ? JSON.parse(String(options.body)) : {}
    const authorization = new Headers(options.headers).get('Authorization')!
    if (uri.pathname.includes('/access_tokens')) {
      await jwtVerify(authorization.slice(7), publicKey, { issuer: '4242', algorithms: ['RS256'] })
      minted.push(body)
      const token = `installation-capability-${minted.length}`
      tokens.set(token, body)
      return Response.json({ token })
    }
    const capability = tokens.get(authorization.slice(7))!
    expect(capability).toBeDefined()
    const source = uri.pathname.startsWith('/repos/source/')
    expect(capability.repository_ids).toEqual([source ? 11 : 22])
    calls.push({ path: uri.pathname, method, body })
    if (method !== 'GET') {
      if (source) { expect(uri.pathname).toMatch(/\/pulls(?:\/\d+)?$/u); expect(capability.permissions.pull_requests).toBe('write'); expect(capability.permissions.contents).toBe('read') }
      else expect(capability.permissions.contents).toBe('write')
    }
    if (uri.pathname.endsWith(`/tarball/${baseSha}`)) return new Response(null, { status: archiveRedirectStatus, headers: { Location: archiveLocation } })
    if (uri.pathname.endsWith('/commits/main')) return Response.json({ sha: baseSha, commit: { tree: { sha: baseTree } } })
    if (uri.pathname.endsWith('/git/trees')) return Response.json({ sha: (++sequence).toString(16).padStart(40, '0') })
    if (uri.pathname.endsWith('/git/commits')) return Response.json({ sha: (++sequence).toString(16).padStart(40, '0') })
    if (/\/git\/commits\/[a-f0-9]{40}$/u.test(uri.pathname)) return Response.json({ sha: head, tree: { sha: baseTree } })
    if (uri.pathname.includes('/git/ref/heads/')) return head ? Response.json({ object: { sha: head } }) : Response.json({}, { status: 404 })
    if (uri.pathname.endsWith('/git/refs') || uri.pathname.includes('/git/refs/heads/')) {
      if (method === 'PATCH') expect(body.force).toBe(false)
      head = body.sha; return Response.json({ object: { sha: head } })
    }
    if (uri.pathname.endsWith('/pulls')) {
      if (method === 'GET') return Response.json(pr ? [currentPr()] : [])
      pr = { number: 1, state: 'open', merged: false, title: body.title, body: body.body }
      if (dropPrResponse) { dropPrResponse = false; throw new Error('Lost response after GitHub created the PR') }
      return Response.json(currentPr(), { status: 201 })
    }
    if (uri.pathname.endsWith('/pulls/1')) {
      expect(['read', 'write']).toContain(capability.permissions.pull_requests)
      if (method === 'PATCH') pr = { ...pr, ...body }
      return Response.json(currentPr())
    }
    if (uri.pathname.endsWith('/check-runs')) {
      expect(capability.permissions.checks).toBe('read')
      return Response.json({ total_count: 1, check_runs: [{ name: 'lint', head_sha: head, status: 'completed', conclusion: lintSuccess ? 'success' : 'failure', details_url: null }] })
    }
    if (uri.pathname.endsWith('/status')) {
      expect(capability.permissions.statuses).toBe('read')
      return Response.json({ statuses: [{ context: 'build', state: 'success', target_url: 'https://candidate.dev.llll.gg' }, { context: 'untrusted', state: 'success', target_url: 'https://dev.llll.gg.attacker.example' }] })
    }
    throw new Error(`Unexpected GitHub operation: ${method} ${uri.pathname}`)
  }))
  const owner = (await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } }))!
  run = await createAgentRun(env, owner, { agentId: 'agent-user', channelId: 'code-channel', taskId: 'code-task', prompt: 'Fix behavior and open a PR', idempotencyKey: 'code-request' })
  db.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(run.id)
  run = (await findAgentRun(env, run.id))!
})
afterEach(() => { vi.unstubAllGlobals(); db.close() })

describe('GitHub capability broker', () => {
  it('writes only the Run-owned fork branch and deduplicates repeated publication', async () => {
    const first = await publishCodeProposal(env, run.id, input())
    expect(first).toMatchObject({ url: 'https://github.com/source/project/pull/1', status: 'draft', checks: 'unverified' })
    expect(await publishCodeProposal(env, run.id, input())).toEqual(first)
    expect(count('/git/commits')).toBe(1); expect(count('/git/refs')).toBe(1); expect(count('/pulls')).toBe(1)
    expect(calls.find(call => call.path.endsWith('/git/refs'))?.body.ref).toBe(`refs/heads/l4-agent/${run.id}`)
    expect(minted.filter(token => token.permissions.contents === 'write').every(token => token.repository_ids[0] === 22)).toBe(true)
    expect(JSON.stringify(first)).not.toContain('installation-capability')
    expect(JSON.stringify(first)).not.toContain('PRIVATE KEY')
  })
  it('recovers an uncertain PR response by discovering the existing PR', async () => {
    dropPrResponse = true
    await expect(publishCodeProposal(env, run.id, input())).rejects.toThrow('Lost response')
    await expect(publishCodeProposal(env, run.id, input())).resolves.toMatchObject({ number: 1 })
    expect(count('/pulls')).toBe(1)
    expect(count('/git/commits')).toBe(1)
  })
  it('requires explicit code-publication permission even when the Owner starts the Run', async () => {
    db.prepare("UPDATE roles SET permissions_bitmask=? WHERE id='agent-role'").run(permissions & ~Permission.proposeCode)
    const before = minted.length
    await expect(publishCodeProposal(env, run.id, input())).rejects.toMatchObject({ statusCode: 403 })
    expect(minted.length).toBe(before)
    expect(count('/pulls')).toBe(0)
  })
  it('does not publish workflow files or move a branch changed outside the Run', async () => {
    await expect(publishCodeProposal(env, run.id, { ...input(), files: [{ path: '.github/workflows/deploy.yml', content: 'unsafe', executable: false }] })).rejects.toThrow()
    expect(count('/git/commits')).toBe(0)
    await publishCodeProposal(env, run.id, input())
    head = 'f'.repeat(40)
    await expect(publishCodeProposal(env, run.id, { ...input(), title: 'Follow-up', files: [{ path: 'src/index.js', content: 'export const answer=43', executable: false }] })).rejects.toMatchObject({ statusCode: 409 })
    expect(head).toBe('f'.repeat(40))
    expect(count(`/git/refs/heads/l4-agent/${run.id}`, 'PATCH')).toBe(0)
  })
  it('reports independent checks for the exact head and filters Preview hosts', async () => {
    const proposal = await publishCodeProposal(env, run.id, input())
    expect(await codeProposalChecks(env, run.id)).toMatchObject({ readyForReview: false, required: [{ name: 'lint', status: 'failure' }, { name: 'build', status: 'success' }], previews: ['https://candidate.dev.llll.gg'] })
    lintSuccess = true
    expect(await codeProposalChecks(env, run.id)).toMatchObject({ readyForReview: true, commit: proposal.commit })
    head = 'e'.repeat(40)
    await expect(codeProposalChecks(env, run.id)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('revokes repository writes after environment edits or task reassignment', async () => {
    db.exec("UPDATE agent_environments SET version=version+1 WHERE id='code-env'")
    await expect(publishCodeProposal(env, run.id, input())).rejects.toMatchObject({ statusCode: 403 })
    db.exec("UPDATE agent_environments SET version=1 WHERE id='code-env'; UPDATE tasks SET assignee_id='owner-user' WHERE id='code-task'")
    await expect(publishCodeProposal(env, run.id, input())).rejects.toMatchObject({ statusCode: 403 })
    expect(count('/pulls')).toBe(0)
  })
  it('restores only files from the same conversation, task and repository snapshot', async () => {
    db.prepare("UPDATE agent_runs SET status='completed',files_key='private-files' WHERE id=?").run(run.id)
    const current = { ...run, id: 'another-run', createdAt: '9999-01-01' }
    expect(await previousRunFiles(env, current)).toBe('private-files')
    expect(await previousRunFiles(env, { ...current, taskId: 'other-task' })).toBeNull()
    expect(await previousRunFiles(env, { ...current, sessionId: 'other-session' })).toBeNull()
    expect(await previousRunFiles(env, { ...current, environmentJson: JSON.stringify({ ...JSON.parse(run.environmentJson!), baseSha: 'c'.repeat(40) }) })).toBeNull()
    const auth = await runAuthorization(env, run)
    auth.principal.resourceAccess = { repositories: [] }
    await expect(requireRunFiles(env, auth, run)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('freezes scheduled repository authority and refuses it after configuration changes', async () => {
    env.AGENT_SCHEDULE_DO = { getByName: () => ({ wake: async () => {} }) } as unknown as NonNullable<L4Env['AGENT_SCHEDULE_DO']>
    const owner = (await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } }))!
    const scheduled = await createSchedule(env, owner, { kind: 'work', content: 'Fix behavior', agentId: 'agent-user', taskId: 'code-task', channelId: 'code-channel',
      firstAt: new Date(Date.now() + 60000).toISOString(), timezone: 'UTC', recurrence: 'once' })
    const row = db.prepare('SELECT mandate_json as mandate FROM agent_schedules WHERE id=?').get(scheduled.id)!
    const mandate = JSON.parse(String(row.mandate))
    expect(mandate).toMatchObject({ environmentId: 'code-env', environmentVersion: 1, computer: true })
    db.exec("UPDATE agent_environments SET version=2 WHERE id='code-env'")
    await expect(createAgentRun(env, owner, { agentId: 'agent-user', channelId: 'code-channel', taskId: 'code-task', prompt: 'Scheduled work', idempotencyKey: 'scheduled-attempt' }, mandate)).rejects.toMatchObject({ statusCode: 403 })
  })

})


describe('Workers repository archive transport', () => {
  it.each([302, 303])('downloads exact-SHA archives on a %s redirect without forwarding App credentials', async status => {
    archiveRedirectStatus = status
    expect(await (await codeRepositoryArchive(env, run.id)).text()).toBe('archive-bytes')
    const networkCalls = vi.mocked(fetch).mock.calls.length
    expect(await (await codeRepositoryArchive(env, run.id)).text()).toBe('archive-bytes')
    expect(vi.mocked(fetch).mock.calls.length).toBe(networkCalls)
    expect(storedArchives.size).toBe(1)
    db.prepare("UPDATE agent_environments SET enabled=0 WHERE id='code-env'").run()
    await expect(codeRepositoryArchive(env, run.id)).rejects.toMatchObject({ statusCode: 403 })
  })
  it.each([
    'https://codeload.github.com/other/project/legacy.tar.gz/' + baseSha,
    'https://codeload.github.com/source/project/legacy.tar.gz/main',
    'https://codeload.github.com/source/project/legacy.tar.gz/' + 'f'.repeat(40),
    'https://user:secret@codeload.github.com/source/project/legacy.tar.gz/' + baseSha,
    'https://codeload.github.com.attacker.example/source/project/legacy.tar.gz/' + baseSha,
    'http://169.254.169.254/archive',
    'invalid-location',
  ])('rejects an archive destination outside the authorized identity: %s', async location => {
    archiveLocation = location
    await expect(codeRepositoryArchive(env, run.id)).rejects.toMatchObject({ statusCode: 502 })
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('https://codeload.github.com/'))).toBe(false)
    expect(storedArchives.size).toBe(0)
  })
  it('rejects a second redirect without following it or caching its response', async () => {
    archiveStatus = 302
    await expect(codeRepositoryArchive(env, run.id)).rejects.toMatchObject({ statusCode: 502 })
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('169.254.169.254'))).toBe(false)
    expect(storedArchives.size).toBe(0)
  })
  it('rechecks current scope after download before caching or delivering private code', async () => {
    archiveHook = () => { db.prepare("UPDATE agent_environments SET enabled=0 WHERE id='code-env'").run() }
    await expect(codeRepositoryArchive(env, run.id)).rejects.toMatchObject({ statusCode: 403 })
    expect(storedArchives.size).toBe(0)
  })
})

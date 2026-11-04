import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { previousRunTranscript, compatibleRunHistory } from '../../server/utils/agent-context'
import { previousRunFiles } from '../../server/utils/agent-files'
import type { AgentRun } from '../../shared/agent-execution'
let f: ReturnType<typeof mcpFixture>, prior: AgentRun, next: AgentRun, get: ReturnType<typeof vi.fn>
beforeEach(async () => {
  f = mcpFixture()
  prior = (await f.run()).run
  f.db.prepare("UPDATE agent_runs SET status='completed',files_key='private-files' WHERE id=?").run(prior.id)
  f.db.prepare('UPDATE agent_sessions SET transcript_key=? WHERE id=?').run(`agent-sessions/${prior.sessionId}/${prior.id}.jsonl`, prior.sessionId)
  next = (await f.run()).run
  f.db.prepare("UPDATE agent_runs SET created_at='9999-01-01' WHERE id=?").run(next.id)
  next = { ...next, createdAt: '9999-01-01' }
  get = vi.fn(async () => ({ size: 24, text: async () => 'PRIVATE_FIRST_MEMBER_DATA' }))
  f.env.FILES = { get } as unknown as R2Bucket
})
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })
describe('private Run continuation', () => {
  it('restores only a canonical completed archive and files under unchanged identity and authority', async () => {
    expect(await previousRunTranscript(f.env, next)).toBe('PRIVATE_FIRST_MEMBER_DATA')
    expect(await previousRunFiles(f.env, next)).toBe('private-files')
    expect(get).toHaveBeenCalledWith(`agent-sessions/${prior.sessionId}/${prior.id}.jsonl`)
  })
  it('starts clean for another initiator without reading private storage', async () => {
    f.db.prepare('UPDATE agent_runs SET initiated_by=? WHERE id=?').run(ids.member, next.id)
    next = { ...next, initiatedBy: ids.member }
    expect(await previousRunTranscript(f.env, next)).toBeNull()
    expect(await previousRunFiles(f.env, next)).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
  it('does not rewind to an older matching snapshot once private history was mixed', async () => {
    f.db.prepare('UPDATE agent_runs SET initiated_by=? WHERE id=?').run(ids.member, next.id)
    const later = { ...prior, id: 'later-private-run', createdAt: '9999-12-31' }
    expect(await previousRunTranscript(f.env, later)).toBeNull()
    expect(await previousRunFiles(f.env, later)).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
  it.each(['mandate_json', 'environment_json', 'model', 'instructions'] as const)('starts clean when %s changed', async column => {
    f.db.prepare(`UPDATE agent_runs SET ${column}=? WHERE id=?`).run(column === 'mandate_json' ? JSON.stringify({ ...JSON.parse(prior.mandateJson), resourceAccess: { documents: [] } }) : 'changed', prior.id)
    expect(await compatibleRunHistory(f.env, next)).toBe(false)
    expect(await previousRunTranscript(f.env, next)).toBeNull()
    expect(await previousRunFiles(f.env, next)).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
  it('does not restore context across Tasks even when Role permissions are identical', async () => {
    expect(await previousRunTranscript(f.env, { ...next, taskId: 'another-task' })).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
  it('does not trust a dangling or arbitrary Session archive key', async () => {
    f.db.prepare('UPDATE agent_sessions SET transcript_key=? WHERE id=?').run('other-member/private.jsonl', next.sessionId)
    expect(await previousRunTranscript(f.env, next)).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
  it('does not import a failed or uncertain prior attempt as completed history', async () => {
    f.db.prepare("UPDATE agent_runs SET status='failed' WHERE id=?").run(prior.id)
    expect(await previousRunTranscript(f.env, next)).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
})

import { afterEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture, remoteMcp } from '../helpers/outbound-mcp'
import { toolsForRun } from '../../server/utils/agent-tools'
import { agentGateway } from '../../server/utils/agent-gateway'
import { runEmbeddedPi } from '../../workers/agent-pi-durable'
import { deliverAgentRun } from '../../server/utils/agent-run-delivery'
import { findAgentRun, runCapability } from '../../server/utils/agent-run-service'

vi.mock('@earendil-works/pi-durable/storage/sqlite/cloudflare', async () => {
  const { MemoryStorage } = await import('@earendil-works/pi-durable')
  return { openDurableObjectSqliteStorage: async () => new MemoryStorage() }
})
afterEach(() => vi.unstubAllGlobals())
it('uses real embedded Pi, lazy discovery and the Server broker for an attributed external read', async () => {
  const f = mcpFixture(), remote = remoteMcp()
  try {
    const connection = await f.connect(f.input({ credential: 'synthetic-pi-secret' }))
    f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('docs-board', 'Research', ids.owner)
    const taskId = crypto.randomUUID()
    f.db.prepare("INSERT INTO tasks(id,board_id,title,status,assignee_id,created_by,channel_id,created_at,updated_at) VALUES(?,'docs-board','Research public docs','ready',?,?,'public-chat','2026-10-25','2026-10-25')").run(taskId, ids.agent, ids.owner)
    const { run, authorization } = await f.run(ids.owner, undefined, taskId)
    const tools = await toolsForRun(f.env, authorization, () => {}, run)
    const external = tools.descriptors.find(tool => tool.name.startsWith('mcp_'))!
    let turn = 0
    const brokerCalls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://docs.mcp.cloudflare.com')) return remote.network(url, init)
      const body = JSON.parse(String(init?.body))
      if (String(url).endsWith('/tools')) {
        brokerCalls.push(body.name)
        return agentGateway(new Request(String(url), init), f.env, run.id, 'tools', () => {})
      }
      const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
      expect(JSON.stringify(body)).not.toContain('synthetic-pi-secret')
      if (turn < 2) expect(names).not.toContain(external.name)
      const selection = [
        { name: 'search_tools', arguments: JSON.stringify({ query: 'Cloudflare documentation' }) },
        { name: 'get_tool_details', arguments: JSON.stringify({ name: external.name, purpose: 'Find cited documentation' }) },
        { name: external.name, arguments: JSON.stringify({ query: 'Durable Objects' }) },
      ][turn++]
      if (turn === 3) expect(names).toContain(external.name)
      if (!selection) expect(JSON.stringify(body.messages)).toContain('Verified source')
      const delta = selection ? { role: 'assistant', tool_calls: [{ index: 0, id: 'mcp-pi-' + turn, type: 'function', function: selection }] }
        : { role: 'assistant', content: 'Evidence: https://developers.cloudflare.com/workers/' }
      const frame = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
      return new Response(frame(delta, null) + frame({}, selection ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    })
    const outcome = await runEmbeddedPi({ runId: run.id, prompt: 'Research Durable Objects', instructions: 'Cite evidence.', tools: tools.descriptors,
      toolEndpoint: `https://fixture.invalid/api/agent-runs/${run.id}/gateway/tools`, modelGateway: { url: 'https://fixture.invalid/v1', model: 'fixture', token: await runCapability(f.env, run.id) } }, {} as DurableObjectStorage)
    expect(outcome.result).toMatchObject({ type: 'result', text: 'Evidence: https://developers.cloudflare.com/workers/' })
    expect(brokerCalls).toEqual(['get_tool_details', external.name])
    expect(outcome.transcript).toContain(connection.id)
    expect(outcome.transcript).not.toContain('synthetic-pi-secret')
    expect(remote.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
    if (outcome.result.type !== 'result') throw new Error('Missing Pi result')
    f.db.prepare("UPDATE agent_runs SET status='completed',result_text=? WHERE id=?").run(outcome.result.text, run.id)
    const publish = vi.fn(async () => {})
    await deliverAgentRun(f.env, (await findAgentRun(f.env, run.id))!, publish)
    expect(f.db.prepare('SELECT status,result_summary FROM tasks WHERE id=?').get(taskId)).toMatchObject({ status: 'review', result_summary: outcome.result.text })
    expect(publish).toHaveBeenCalledOnce()
  } finally { f.db.close() }
})

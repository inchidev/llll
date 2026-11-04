import type { L4Env } from '../../workers/env'
import { factoryAuthority, factoryHash, factoryWorkspace } from './factory-authority'
import { approvedPlan, expireFactoryActions } from './factory-actions'
import type { RunMandate } from '../../shared/agent-execution'

export async function factoryStatus(env: L4Env, runId: string) {
  const context = await factoryAuthority(env, runId)
  await expireFactoryActions(env)
  const workspace = await factoryWorkspace(env, context)
  const actions = await env.DB.prepare('SELECT id,status,run_id AS runId,request_json AS requestJson,result_json AS resultJson FROM factory_actions WHERE workspace_id=? ORDER BY created_at DESC LIMIT 10').bind(workspace.id).all<{ id: string; status: string; runId: string; requestJson: string; resultJson: string | null }>()
  const ephemeral = 'provider' in context.capabilities
  const mode = (JSON.parse(context.run.mandateJson) as RunMandate).execution?.mode ?? 'review'
  const plan = mode === 'plan' ? await approvedPlan(env, workspace.id) : null
  const planInstruction = mode !== 'plan' ? '' : plan && plan.remaining > 0
    ? `Your approved plan covers ${plan.remaining} more operations and egress to ${plan.plan.networkHosts.join(', ') || 'no hosts'}. Anything outside it waits for review; propose a new plan if the work changes. `
    : 'Propose a plan first (operation plan: summary, steps, networkHosts, operations). After the person approves it, the operations it covers run without separate review; publishing still waits. '
  return { approvalMode: mode, plan: plan ? { remaining: plan.remaining, networkHosts: plan.plan.networkHosts } : null, provider: ephemeral ? 'cloudflare-containers' : 'docker-node', caches: ephemeral ? 'disposable' : 'persistent-task-disk', workspaceId: workspace.id, status: workspace.status, repository: context.environment.sourceRepo, baseSha: context.environment.baseSha,
    branch: 'l4-agent/' + workspace.id, commands: workspace.commands, runtimeMs: workspace.runtimeMs, publications: workspace.publicationCount,
    snapshotDigest: workspace.snapshotJson ? await factoryHash(workspace.snapshotJson) : null,
    pull: workspace.pullJson ? JSON.parse(workspace.pullJson) : null,
    recentActions: actions.results.map(({ requestJson, resultJson, ...action }) => {
      const request = JSON.parse(requestJson), result = resultJson ? JSON.parse(resultJson) : null
      return { ...action, operation: request.operation, path: request.path, command: request.command?.slice(0, 500),
        exitCode: result?.exitCode, output: result?.output?.slice(0, 1000), reviewUrl: `/runs/${action.runId}` }
    }),
    nodeLastSeen: context.nodeLastSeen, limits: { operations: 50, runtimeMs: 3600000, publications: 10, diskBytes: context.capabilities.diskBytes, timeoutMs: 'timeoutMs' in context.capabilities ? context.capabilities.timeoutMs : 120000 },
    instruction: planInstruction + (workspace.status === 'new' || workspace.status === 'released' ? 'Request bootstrap before using the checkout.' : 'Resume the existing checkout; never bootstrap again or replay an uncertain action.' + (ephemeral ? ' Each operation uses a fresh container. Combine dependency setup and dependent tests/builds in the same reviewed exec with the required approved HTTPS hosts; caches and running services are disposable. Do not repeat completed source edits.' : '')) }
}

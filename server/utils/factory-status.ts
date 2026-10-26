import type { L4Env } from '../../workers/env'
import { factoryAuthority, factoryHash, factoryWorkspace } from './factory-authority'
import { expireFactoryActions } from './factory-actions'

export async function factoryStatus(env: L4Env, runId: string) {
  const context = await factoryAuthority(env, runId)
  await expireFactoryActions(env)
  const workspace = await factoryWorkspace(env, context)
  const actions = await env.DB.prepare('SELECT id,status,run_id AS runId FROM factory_actions WHERE workspace_id=? ORDER BY created_at DESC LIMIT 10').bind(workspace.id).all<{ id: string; status: string; runId: string }>()
  return { workspaceId: workspace.id, status: workspace.status, repository: context.environment.sourceRepo, baseSha: context.environment.baseSha,
    branch: 'l4-agent/' + workspace.id, commands: workspace.commands, runtimeMs: workspace.runtimeMs, publications: workspace.publicationCount,
    snapshotDigest: workspace.snapshotJson ? await factoryHash(workspace.snapshotJson) : null,
    pull: workspace.pullJson ? JSON.parse(workspace.pullJson) : null,
    recentActions: actions.results.map(action => ({ ...action, reviewUrl: `/runs/${action.runId}` })),
    nodeLastSeen: context.nodeLastSeen, limits: { operations: 50, runtimeMs: 3600000, publications: 10, diskBytes: context.capabilities.diskBytes },
    instruction: workspace.status === 'new' || workspace.status === 'released' ? 'Request bootstrap before using the checkout.' : 'Resume the existing checkout; never bootstrap again or replay an uncertain action.' }
}

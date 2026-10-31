import type { L4Env } from '../../workers/env'
import { aiProvider } from '../../workers/env'
import { Permission } from '../../shared/permissions'

export type FactoryChecklistStep = 'models' | 'agent' | 'git' | 'computer' | 'project' | 'repository' | 'access' | 'run'
export type FactoryChecklist = { steps: Record<FactoryChecklistStep, boolean>; projectId: string | null; done: boolean }

const work = Permission.readTasks | Permission.executeTasks

/**
 * What a fresh Server still needs before an agent can turn a task into a pull
 * request, in the order the Owner sets it up. One statement, so the Factory
 * overview can show it on every visit.
 */
export async function factoryChecklist(env: L4Env): Promise<FactoryChecklist> {
  const row = await env.DB.prepare(`SELECT
    (SELECT count(*) FROM server_settings WHERE key LIKE 'agents.provider.%' AND json_extract(value,'$.secret') IS NOT NULL AND COALESCE(json_extract(value,'$.enabled'),1)<>0) AS providers,
    (SELECT count(*) FROM agents a JOIN users u ON u.id=a.user_id WHERE a.status='active' AND a.archived_at IS NULL AND u.status='active') AS agents,
    (SELECT count(*) FROM git_connections WHERE enabled=1) AS git,
    (SELECT count(*) FROM compute_nodes WHERE enabled=1) AS computers,
    (SELECT count(*) FROM projects WHERE archived_at IS NULL) AS projects,
    (SELECT r.project_id FROM project_repositories r JOIN projects p ON p.id=r.project_id WHERE p.archived_at IS NULL ORDER BY r.created_at LIMIT 1) AS repositoryProject,
    (SELECT id FROM projects WHERE archived_at IS NULL ORDER BY created_at LIMIT 1) AS firstProject,
    EXISTS(SELECT 1 FROM agents a JOIN users u ON u.id=a.user_id
      WHERE a.status='active' AND a.archived_at IS NULL AND u.status='active' AND (
        (SELECT (permissions_bitmask & ?1)=?1 FROM roles WHERE id=u.role_id)
        OR EXISTS(SELECT 1 FROM grants g JOIN project_policies pp ON pp.id=g.policy_id
          JOIN project_repositories r ON r.project_id=g.project_id JOIN projects p ON p.id=g.project_id
          WHERE g.agent_id IS NULL AND p.archived_at IS NULL AND (pp.permissions_bitmask & ?1)=?1 AND (g.member_id=u.id OR g.role_id=u.role_id)))) AS access,
    EXISTS(SELECT 1 FROM factory_workspaces) AS runs`)
    .bind(work).first<{ providers: number; agents: number; git: number; computers: number; projects: number; repositoryProject: string | null; firstProject: string | null; access: number; runs: number }>()
  const steps: FactoryChecklist['steps'] = {
    // Workers AI or a configured OpenAI-compatible endpoint works without a provider.
    models: Boolean(row?.providers) || aiProvider(env) !== null,
    agent: Boolean(row?.agents),
    git: Boolean(row?.git),
    computer: Boolean(row?.computers),
    project: Boolean(row?.projects),
    repository: Boolean(row?.repositoryProject),
    access: Boolean(row?.access),
    run: Boolean(row?.runs),
  }
  return { steps, projectId: row?.repositoryProject ?? row?.firstProject ?? null, done: Object.values(steps).every(Boolean) }
}

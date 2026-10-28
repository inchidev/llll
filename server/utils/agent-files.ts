import { compatibleRunHistory } from './agent-context'
import { fileStorage } from '../../shared/file-storage'
import { z } from 'zod'
import type { AgentRun } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'
import { runAuthorization } from './agent-run-service'
import { authorize, ServerAction, authorizeResource } from '../../shared/authorization'
import type { AuthorizationContext } from '../../shared/authorization'
import type { RunEnvironment } from '../../shared/code-environments'
import { getTask } from './task-service'
import { fail } from './cf'

export const workingFilesSchema = z.object({ version: z.literal(1), files: z.array(z.object({
  path: z.string().min(1).max(500).refine(value => !value.startsWith('/') && !value.includes('\\') && ![...value].some(c => c.charCodeAt(0) < 32)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')),
  content: z.string().max(700000).regex(/^[A-Za-z0-9+/]*={0,2}$/u).nullable(), executable: z.boolean(),
})).max(100) })
export async function requireRunFiles(env: L4Env, auth: AuthorizationContext, run: AgentRun) {
  authorize(auth, ServerAction.useComputer)
  if (run.taskId) await getTask(env, auth, run.taskId)
  if (run.environmentJson) authorizeResource(auth, 'repositories', String((JSON.parse(run.environmentJson) as RunEnvironment).sourceRepoId))
}
export async function previousRunFiles(env: L4Env, run: AgentRun) {
  // Private artifacts must not inherit data from a different initiator or changed authority.
  if (!await compatibleRunHistory(env, run)) return null
  const previous = await env.DB.prepare(`SELECT files_key as filesKey FROM agent_runs WHERE session_id=? AND initiated_by=? AND
    CASE WHEN json_valid(mandate_json) THEN json_remove(mandate_json,'$.rootRunId') ELSE mandate_json END =
    CASE WHEN json_valid(?) THEN json_remove(?,'$.rootRunId') ELSE ? END AND task_id IS ?
    AND environment_json IS ? AND status='completed' AND files_key IS NOT NULL AND id<>? AND created_at<? ORDER BY created_at DESC,id DESC LIMIT 1`)
    .bind(run.sessionId, run.initiatedBy, run.mandateJson, run.mandateJson, run.mandateJson, run.taskId, run.environmentJson, run.id, run.createdAt).first<{ filesKey: string }>()
  return previous?.filesKey ?? null
}
export async function runtimeFiles(env: L4Env, run: AgentRun): Promise<Response> {
  const auth = await runAuthorization(env, run)
  await requireRunFiles(env, auth, run)
  const key = await previousRunFiles(env, run)
  const object = key ? await fileStorage(env).get(key) : null
  if (!object || object.size > 2000000) fail(404, 'not_found', 'Saved working files are unavailable')
  return new Response(object.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

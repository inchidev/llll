import type { L4Env } from '../../workers/env'
import type { RunMandate } from '../../shared/agent-execution'
import { boxBranch } from '../../shared/software-factory'
import { factoryAuthority, taskBox } from './factory-authority'
import { expireApprovals } from './factory-approvals'

/** The Task's box as its Agent sees it: where its work goes, what it published and what waits for a person. */
export async function factoryStatus(env: L4Env, runId: string) {
  const context = await factoryAuthority(env, runId)
  await expireApprovals(env)
  const box = await taskBox(env, context)
  const execution = (JSON.parse(context.run.mandateJson) as RunMandate).execution
  const mode = execution?.mode ?? 'review'
  const approvals = box ? (await env.DB.prepare('SELECT id,kind,status,request_json AS requestJson,result_json AS resultJson,created_at AS createdAt FROM factory_approvals WHERE box_id=? ORDER BY created_at DESC,id DESC LIMIT 10')
    .bind(box.id).all<{ id: string; kind: string; status: string; requestJson: string; resultJson: string | null; createdAt: string }>()).results : []
  const plan = approvals.find(approval => approval.kind === 'plan')
  const cloud = 'provider' in context.capabilities
  const modeInstruction = mode === 'role' ? 'Publishing your branch needs nobody’s approval in this mode.'
    : mode === 'plan' ? plan?.status === 'approved' ? 'Your approved plan covers publishing. Propose a new plan with factory_plan if the work changes.' : 'Propose a plan with factory_plan. Until a person approves it, each publication waits for review.'
    : 'Each publication waits for a person, who reads its diff.'
  return { approvalMode: mode, provider: cloud ? 'cloudflare-containers' : 'docker-node', disk: cloud ? 'checkpointed to Artifacts between turns' : 'persistent Task disk',
    boxId: box?.id ?? null, status: box?.status ?? 'new', repository: context.environment.sourceRepo, baseBranch: context.environment.baseBranch, baseSha: context.environment.baseSha,
    branch: box ? boxBranch(box.id) : null, runtimeMs: box?.runtimeMs ?? 0, publications: box?.publicationCount ?? 0,
    pull: box?.pullJson ? JSON.parse(box.pullJson) : null,
    recent: approvals.map(({ requestJson, resultJson, ...approval }) => {
      const request = JSON.parse(requestJson) as { sha?: string; title?: string; summary?: string }, result = resultJson ? JSON.parse(resultJson) as { message?: string } : null
      return { ...approval, sha: request.sha, title: request.title ?? request.summary?.slice(0, 160), message: result?.message }
    }),
    nodeLastSeen: context.nodeLastSeen,
    limits: { boxRuntimeMs: execution?.boxRuntimeMs ?? 21600000, publications: execution?.publications ?? 50, diskBytes: context.capabilities.diskBytes },
    instruction: `Work in the checkout with your own tools and commit with Git. To publish, call factory_publish with the commit's full SHA, a title and a body; it pushes to ${box ? boxBranch(box.id) : 'the Task’s branch'} and opens or updates the Task's draft pull request. ${modeInstruction} Then read checks with factory_feedback. Never merge or release.` }
}

import type { L4Env } from '../../workers/env'
import type { RunMandate } from '../../shared/agent-execution'
import { factoryAuthority, taskBox } from './factory-authority'
import { expireApprovals } from './factory-approvals'
import { boxEgress } from './box-egress'
import { publishTarget, repositoryGitFlow } from './project-git-flow'

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
  const egress = box ? (await boxEgress(env, [box.id])).get(box.id) : undefined
  const inEffect = new Map(egress?.secrets.map(secret => [secret.placeholder, secret.hosts]) ?? [])
  const cloud = 'provider' in context.capabilities
  const { gitFlow } = await repositoryGitFlow(env, context.environment.id)
  const target = box ? publishTarget(gitFlow, box.id, context.environment) : null, base = context.environment.baseBranch
  const inL4 = context.environment.provider === 'artifacts'
  const flowInstruction = gitFlow.merge === 'direct_push'
    ? `This Project’s Git flow pushes straight to ${base}: factory_publish pushes your commit there as a fast-forward, without a pull request, and a push that does not descend from ${base}'s current head is refused. There is no pull request for factory_feedback to read; whatever builds from ${base} takes it from there.`
    : inL4
      ? `This repository lives in L4: there is no GitHub or Gitea, no pull request and no CI. factory_publish pushes to ${target?.ref ?? `the Task’s branch (${gitFlow.branchPrefix}<box id>)`} and records the commit for review in L4; factory_feedback reports no checks. A person reads the diff and merges it into ${base} from the Task (${gitFlow.method}); never merge it yourself. Keep your branch up to date with ${base}: L4 merges only a branch that includes ${base}’s current commit.`
      : `factory_publish pushes to ${target?.ref ?? `the Task’s branch (${gitFlow.branchPrefix}<box id>)`} and opens or updates the Task's draft pull request. Then read checks with factory_feedback. ${gitFlow.merge === 'agent_after_checks'
      ? `Once factory_feedback reports readyForReview, merge it with factory_merge and the head's SHA (${gitFlow.method}); branch protection may still refuse, and its reason stands.`
      : 'A person merges it from the Task; never merge it yourself.'}`
  const modeInstruction = mode === 'role' ? 'Publishing your branch needs nobody’s approval in this mode.'
    : mode === 'plan' ? plan?.status === 'approved' ? 'Your approved plan covers publishing. Propose a new plan with factory_plan if the work changes.' : 'Propose a plan with factory_plan. Until a person approves it, each publication waits for review.'
    : 'Each publication waits for a person, who reads its diff.'
  return { approvalMode: mode, provider: cloud ? 'cloudflare-containers' : 'docker-node', disk: cloud ? 'checkpointed to Artifacts between turns' : 'persistent Task disk',
    boxId: box?.id ?? null, status: box?.status ?? 'new', repository: context.environment.sourceRepo, gitProvider: context.environment.provider, baseBranch: context.environment.baseBranch, baseSha: context.environment.baseSha,
    branch: target?.ref ?? null, gitFlow, pushedSha: box?.pushedSha ?? null, runtimeMs: box?.runtimeMs ?? 0, publications: box?.publicationCount ?? 0,
    pull: box?.pullJson ? JSON.parse(box.pullJson) : null,
    recent: approvals.map(({ requestJson, resultJson, ...approval }) => {
      const request = JSON.parse(requestJson) as { sha?: string; title?: string; summary?: string }, result = resultJson ? JSON.parse(resultJson) as { message?: string } : null
      return { ...approval, sha: request.sha, title: request.title ?? request.summary?.slice(0, 160), message: result?.message }
    }),
    nodeLastSeen: context.nodeLastSeen,
    // What the box reaches now, and the Project secrets it may send as placeholders.
    network: { open: egress?.hosts ?? [], secrets: (egress?.known ?? []).map(secret => ({ placeholder: secret.placeholder, boundTo: secret.hosts, putInAt: inEffect.get(secret.placeholder) ?? [] })) },
    limits: { boxRuntimeMs: execution?.boxRuntimeMs ?? 21600000, publications: execution?.publications ?? 50, diskBytes: context.capabilities.diskBytes },
    instruction: `Work in the checkout with your own tools and commit with Git. To publish, call factory_publish with the commit's full SHA, a title and a body. ${flowInstruction} ${modeInstruction} Never release. The network reaches only the hosts in network.open; for another host, or a secret not yet put in at its host, call request_network_window. Send a secret only as its placeholder.` }
}

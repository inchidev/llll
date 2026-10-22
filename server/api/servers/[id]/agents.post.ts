import { agentProviderCatalog } from '../../../utils/agent-providers'
import { piConfigured } from '../../../utils/agent-run-service'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { agents, roles, users } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import type { AgentDTO } from '../../../../shared/types'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'
import { signalMembersChanged } from '../../../../workers/member-events'
import { agentRuntimeConfigured, aiProvider, resolveAgentModelId } from '../../../../workers/env'

const bodySchema = z.object({
  harness: z.enum(['pi', 'think']).optional(),
  displayName: z.string().trim().min(1).max(80),
  // Empty model resolves to this Server's default profile (openai-compatible: AI_MODEL).
  model: z.string().trim().max(200).default(''),
  instructions: z.string().trim().max(12_000).default(''),
})

export default defineEventHandler(async (event): Promise<{ agent: AgentDTO }> => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId, Permission.manageAgents)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const harness = body.harness ?? ((await piConfigured(env)) ? 'pi' : 'think')
  if (harness === 'pi' && !await piConfigured(env)) fail(409, 'pi_unconfigured', 'Configure a Pi execution provider first')
  if (harness !== 'pi' && !agentRuntimeConfigured(env)) {
    const provider = aiProvider(env)
    fail(409, 'agent_runtime_disabled', provider
      ? 'The Agent Durable Object must be bound before creating an agent'
      : 'Bind Workers AI, set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or set AI_BASE_URL, AI_API_KEY, and AI_MODEL, before creating an agent')
  }
  const model = (harness === 'pi' && !body.model ? (await agentProviderCatalog(env)).defaultModel : null) ?? resolveAgentModelId(env, body.model)
  const db = getDb(env.DB)
  const memberRole = (await db.select().from(roles).where(eq(roles.key, 'member')).limit(1))[0]
  if (!memberRole) fail(409, 'server_incomplete', 'Member role not found')

  const id = newId()
  const now = nowIso()
  await db.batch([
    db.insert(users).values({
      id,
      kind: 'agent',
      handle: null,
      displayName: body.displayName,
      avatarR2Key: null,
      status: 'active',
      roleId: memberRole.id,
      nickname: null,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(agents).values({
      userId: id,
      harness,
      model,
      instructions: body.instructions,
      status: 'active',
      createdBy: actor.user.id,
      lastActiveAt: null,
      createdAt: now,
      updatedAt: now,
    }),
  ])
  await writeAudit(env, {
    serverId,
    actorId: actor.user.id,
    action: 'agent.create',
    targetType: 'agent',
    targetId: id,
    meta: { displayName: body.displayName, model },
  })
  waitUntil(signalMembersChanged(env, serverId))
  return {
    agent: {
      id,
      harness,
      displayName: body.displayName,
      avatarR2Key: null,
      model,
      instructions: body.instructions,
      status: 'active',
      lastActiveAt: null,
      createdAt: now,
      updatedAt: now,
    },
  }
})

import { agentConnectionId } from '../../../../../shared/agent-providers'
import { decryptSecret } from '../../../../../shared/encrypted-secret'
import { agentProviderKey, agentProviderScope, loadAgentProvider, type ChatGPTCredentials } from '../../../../utils/agent-providers'
import { providerManager } from '../../../../utils/agent-provider-access'
import { cf } from '../../../../utils/cf'
import { writeAudit } from '../../../../utils/messages'
import { parseBody } from '../../../../utils/validate'
export default defineEventHandler(async event => {
  const manager = await providerManager(event), actor = manager.actor
  const id = parseBody(agentConnectionId, getRouterParam(event, 'provider'))
  const { env } = cf(event)
  // Delete locally first: neither in-flight refresh nor an old callback may restore it.
  const current = await loadAgentProvider(env, id)
  manager.require(current?.kind, current)
  await env.DB.prepare('DELETE FROM server_settings WHERE key=?').bind(agentProviderKey(id)).run()
  let revoked = true
  if (current?.kind === 'chatgpt' && current.secret && env.AUTH_SECRET) {
    const credentials = JSON.parse(await decryptSecret(env.AUTH_SECRET, agentProviderScope(id), current.secret)) as ChatGPTCredentials
    try {
      const response = await fetch('https://auth.openai.com/api/accounts/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: credentials.refreshToken, token_type_hint: 'refresh_token', client_id: credentials.clientId }), signal: AbortSignal.timeout(15000), redirect: 'manual' })
      revoked = response.ok
    } catch { revoked = false }
  }
  if (current) await writeAudit(env, { serverId: getRouterParam(event, 'id')!, actorId: actor.user.id, action: 'agent.provider.remove', targetType: 'agent_provider', targetId: id, meta: { kind: current.kind, revoked } })
  setHeader(event, 'Cache-Control', 'no-store')
  return { removed: true, revoked }
})

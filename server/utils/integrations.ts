import { z } from 'zod'
import { integrationFields, integrationKeys, offCloudflareKeys, type IntegrationKey, type IntegrationsDTO } from '../../shared/integrations'
import { browserProvider, callsProvider, cloudflareNetwork, type L4Env } from '../../workers/env'
import { emailInboundProvider } from '../../workers/inbound-email'
import { loadSavedIntegrations, saveIntegrations, withIntegrations } from '../../workers/integrations'
import { serverEmailProvider } from '../../workers/mail-transport'
import { resolveAiFunction } from './ai-functions'
import { fail } from './cf'

export async function integrationsStatus(env: L4Env, actorId: string, origin: string): Promise<IntegrationsDTO> {
  const saved = await loadSavedIntegrations(env), effective = await withIntegrations(env)
  const onCloudflare = cloudflareNetwork(effective)
  const shown = onCloudflare ? integrationKeys.filter(key => !offCloudflareKeys.includes(key)) : integrationKeys
  const fields: IntegrationsDTO['fields'] = {}
  for (const key of shown) {
    // `env` may already carry the saved value; only a different one came from the deployment.
    const current = String((env as unknown as Record<string, unknown>)[key] ?? '').trim()
    const fromDeployment = current && current !== saved[key] ? current : ''
    const value = fromDeployment || saved[key] || ''
    fields[key] = { source: fromDeployment ? 'deployment' : saved[key] ? 'settings' : null, value: value && !integrationFields[key].secret ? value : null }
  }
  let openrouter = false
  try { await resolveAiFunction(effective, 'web.search', actorId); openrouter = true } catch { /* Not set up. */ }
  return { cloudflareNetwork: onCloudflare, fields,
    status: { search: effective.EXA_API_KEY ? 'exa' : openrouter ? 'openrouter' : null, pages: browserProvider(effective), outbound: serverEmailProvider(effective), inbound: emailInboundProvider(effective), calls: callsProvider(effective) },
    webhooks: { bridge: `${origin}/api/email/inbound`, postmark: `${origin}/api/email/inbound/postmark`, mailgun: `${origin}/api/email/inbound/mailgun`, ses: `${origin}/api/email/inbound/ses` } }
}

const updateSchema = z.object({ values: z.record(z.string(), z.string().nullable()) }).strict()
export async function updateIntegrations(env: L4Env, body: unknown) {
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) fail(400, 'integration_invalid', 'These settings are not valid')
  const saved = new Map(Object.entries(await loadSavedIntegrations(env)) as Array<[IntegrationKey, string]>)
  const changed: IntegrationKey[] = []
  for (const [name, value] of Object.entries(parsed.data.values)) {
    if (!integrationKeys.includes(name as IntegrationKey)) fail(400, 'integration_invalid', 'Unknown setting')
    const key = name as IntegrationKey
    changed.push(key)
    if (value === null || value.trim() === '') { saved.delete(key); continue }
    const valid = integrationFields[key].schema.safeParse(value)
    if (!valid.success) fail(400, 'integration_invalid', `${key}: ${valid.error.issues[0]?.message ?? 'Not valid'}`)
    saved.set(key, valid.data)
  }
  if (!env.AUTH_SECRET) fail(503, 'integration_encryption', 'Server credential encryption is unavailable')
  await saveIntegrations(env, Object.fromEntries(saved))
  return changed
}

/** Only a signed-in Owner: agents, MCP tokens and delegated sessions cannot change these. */
export function requireIntegrationOwner(member: { isOwner: boolean; authorization: { principal: { kind: string }; credential: { kind: string }; delegation?: unknown } }) {
  const { principal, credential, delegation } = member.authorization
  if (!member.isOwner || principal.kind !== 'human' || credential.kind !== 'session' || delegation) fail(403, 'forbidden', 'Only the signed-in Owner can change this')
}

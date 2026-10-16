import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authAccounts, authProviderCredentials, authSettings } from '../../../../drizzle/schema'
import type { AuthCredentialProvider, AuthSettingsAdminDTO } from '../../../../shared/types'
import { nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { AUTH_PROVIDERS, authSecret, authSettingsAdminDto, forgetSessionAuthConfig, loadAuthRuntimeConfig } from '../../../utils/auth-config'
import { encryptAuthSecret } from '../../../utils/auth-secrets'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const providerSchema = z.object({
  enabled: z.boolean(),
  publicKey: z.string().trim().max(500).nullable(),
  secret: z.string().max(4000).optional(),
  removeCredential: z.boolean().optional(),
})

const bodySchema = z.object({
  registrationMode: z.enum(['open', 'invite_only']),
  email: z.object({
    enabled: z.boolean(),
    sender: z.union([z.string().email().max(320), z.literal('')]).nullable(),
    senderName: z.string().trim().max(100).nullable(),
  }),
  providers: z.object({
    github: providerSchema,
    linkedin: providerSchema,
    google: providerSchema,
    twitter: providerSchema,
    telegram: providerSchema,
    turnstile: providerSchema,
  }),
})

export default defineEventHandler(async (event): Promise<{ auth: AuthSettingsAdminDTO }> => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage authentication')
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const db = getDb(env.DB)
  const current = await loadAuthRuntimeConfig(env, getRequestURL(event).origin)
  if (current.mode === 'access') fail(400, 'managed_by_access', 'Authentication is managed by Cloudflare Access')
  const storedRows = await db.select().from(authProviderCredentials)

  const ready: Record<AuthCredentialProvider, boolean> = {
    github: false,
    linkedin: false,
    google: false,
    twitter: false,
    telegram: false,
    turnstile: false,
  }
  for (const provider of AUTH_PROVIDERS) {
    const incoming = body.providers[provider]
    const deploymentManaged = current.credentials[provider]?.source === 'deployment'
    if (deploymentManaged && (incoming.secret || incoming.removeCredential || incoming.publicKey !== current.credentials[provider]?.publicKey)) {
      fail(400, 'managed_by_deployment', `${provider} credentials are managed by the deployment`)
    }
    const stored = storedRows.find(row => row.provider === provider)
    const publicKey = deploymentManaged
      ? current.credentials[provider]?.publicKey
      : incoming.removeCredential
        ? null
        : incoming.publicKey || stored?.publicKey
    const hasSecret = deploymentManaged
      ? true
      : incoming.removeCredential
        ? false
        : Boolean(incoming.secret?.trim() || (stored && current.credentials[provider]?.secretReadable))
    ready[provider] = Boolean(publicKey && hasSecret)
  }

  const effective = {
    email: body.email.enabled,
    github: body.providers.github.enabled && ready.github,
    linkedin: body.providers.linkedin.enabled && ready.linkedin,
    google: body.providers.google.enabled && ready.google,
    twitter: body.providers.twitter.enabled && ready.twitter,
    telegram: body.providers.telegram.enabled && ready.telegram,
    turnstile: body.providers.turnstile.enabled && ready.turnstile,
  }
  if (!effective.email && !effective.github && !effective.google && !effective.twitter && !effective.telegram && !effective.linkedin) {
    fail(400, 'last_login_method', 'At least one login method must remain available')
  }
  const ownerAccounts = await db.select({ providerId: authAccounts.providerId }).from(authAccounts).where(eq(authAccounts.userId, member.user.id))
  const ownerCanSignIn = ownerAccounts.some((account) => {
    const method = account.providerId === 'credential' ? 'email' : account.providerId
    return method === 'email' || method === 'github' || method === 'google' || method === 'twitter' || method === 'telegram' || method === 'linkedin'
      ? effective[method]
      : false
  })
  if (!ownerCanSignIn) fail(400, 'owner_lockout', 'Keep a login method linked to the owner account enabled')
  const sender = current.email.senderManagedByDeployment ? current.email.from : body.email.sender?.trim() || null
  const emailSignupReady = effective.email && current.email.binding && Boolean(sender) && effective.turnstile
  if (body.registrationMode === 'open' && !emailSignupReady && !effective.github && !effective.google && !effective.twitter && !effective.telegram && !effective.linkedin) {
    fail(400, 'open_signup_unavailable', 'Open signup requires a social provider or verified email signup with Turnstile')
  }

  const changedCredentials: string[] = []
  const key = authSecret(env, getRequestURL(event).origin)
  for (const provider of AUTH_PROVIDERS) {
    const incoming = body.providers[provider]
    if (current.credentials[provider]?.source === 'deployment') continue
    if (incoming.removeCredential) {
      await db.delete(authProviderCredentials).where(eq(authProviderCredentials.provider, provider))
      changedCredentials.push(`${provider}:removed`)
      continue
    }
    const existing = storedRows.find(row => row.provider === provider)
    const publicKey = incoming.publicKey?.trim() || existing?.publicKey
    const plainSecret = incoming.secret?.trim()
    if (!publicKey || (!plainSecret && !existing)) continue
    if (plainSecret) {
      const encrypted = await encryptAuthSecret(key, provider, plainSecret)
      await db.insert(authProviderCredentials).values({
        provider,
        publicKey,
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretVersion: encrypted.version,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      }).onConflictDoUpdate({
        target: authProviderCredentials.provider,
        set: {
          publicKey,
          secretCiphertext: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretVersion: encrypted.version,
          updatedAt: nowIso(),
        },
      })
      changedCredentials.push(`${provider}:${existing ? 'updated' : 'configured'}`)
    }
    else if (existing && existing.publicKey !== publicKey) {
      await db.update(authProviderCredentials).set({ publicKey, updatedAt: nowIso() }).where(eq(authProviderCredentials.provider, provider))
      changedCredentials.push(`${provider}:updated`)
    }
  }

  await db.update(authSettings).set({
    registrationMode: body.registrationMode,
    emailEnabled: body.email.enabled,
    githubEnabled: body.providers.github.enabled,
    linkedinEnabled: body.providers.linkedin.enabled,
    googleEnabled: body.providers.google.enabled,
    twitterEnabled: body.providers.twitter.enabled,
    telegramEnabled: body.providers.telegram.enabled,
    turnstileEnabled: body.providers.turnstile.enabled,
    emailFrom: current.email.senderManagedByDeployment ? null : sender,
    emailFromName: current.email.senderManagedByDeployment ? null : body.email.senderName?.trim() || null,
    updatedAt: nowIso(),
  }).where(eq(authSettings.id, 'main'))

  await writeAudit(env, {
    workspaceId: WORKSPACE_ID,
    actorId: member.user.id,
    action: 'auth.settings.update',
    targetType: 'workspace',
    targetId: WORKSPACE_ID,
    meta: {
      registrationMode: body.registrationMode,
      enabledMethods: Object.entries(effective).filter(([, enabled]) => enabled).map(([method]) => method),
      credentials: changedCredentials,
    },
  })
  forgetSessionAuthConfig()
  return { auth: authSettingsAdminDto(await loadAuthRuntimeConfig(env, getRequestURL(event).origin)) }
})

import { and, desc, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { onboardingAcceptances, onboardingRevisions } from '../../drizzle/schema'
import { newId, nowIso } from '../../shared/ids'
import type { PublicOnboardingConfig, RichTextDocument } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { cf, fail } from './cf'
import { getDb } from './db'

const SOCIAL_ACCEPTANCE_COOKIE = 'df_onboarding_acceptance'
const SOCIAL_ACCEPTANCE_PREFIX = 'onboarding:acceptance:'
const SOCIAL_ACCEPTANCE_TTL = 10 * 60

export function emptyRichTextDocument(): RichTextDocument {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

export function richTextHasContent(document: RichTextDocument | null): boolean {
  if (!document) return false
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    const node = value as { type?: unknown; text?: unknown; content?: unknown }
    if (node.type === 'text' && typeof node.text === 'string' && node.text.trim()) return true
    if (node.type === 'horizontalRule' || node.type === 'image') return true
    return Array.isArray(node.content) && node.content.some(visit)
  }
  return visit(document)
}

export function parseRichTextDocument(value: string): RichTextDocument {
  try {
    const parsed = JSON.parse(value) as { type?: unknown; content?: unknown }
    if (parsed?.type === 'doc' && (parsed.content === undefined || Array.isArray(parsed.content))) {
      return parsed as RichTextDocument
    }
  }
  catch {
    // Corrupt content is treated as empty instead of breaking public authentication pages.
  }
  return emptyRichTextDocument()
}

export function validateRichTextDocument(value: unknown, label: string): RichTextDocument {
  if (!value || typeof value !== 'object') fail(400, 'invalid_document', `${label} must be a Tiptap document`)
  const document = value as { type?: unknown; content?: unknown }
  if (document.type !== 'doc' || (document.content !== undefined && !Array.isArray(document.content))) {
    fail(400, 'invalid_document', `${label} must be a Tiptap document`)
  }
  const serialized = JSON.stringify(document)
  if (serialized.length > 200_000) fail(400, 'document_too_large', `${label} is too large`)
  return document as RichTextDocument
}

export async function loadCurrentOnboarding(env: L4Env): Promise<PublicOnboardingConfig> {
  const row = (await getDb(env.DB).select().from(onboardingRevisions).orderBy(desc(onboardingRevisions.version)).limit(1))[0]
  if (!row) {
    return {
      revisionId: null,
      version: 0,
      privacy: null,
      terms: null,
      rules: null,
      acceptanceRequired: false,
      publishedAt: null,
    }
  }
  const privacy = parseRichTextDocument(row.privacyJson)
  const terms = parseRichTextDocument(row.termsJson)
  const rules = parseRichTextDocument(row.rulesJson)
  const publicPrivacy = richTextHasContent(privacy) ? privacy : null
  const publicTerms = richTextHasContent(terms) ? terms : null
  const publicRules = richTextHasContent(rules) ? rules : null
  return {
    revisionId: row.id,
    version: row.version,
    privacy: publicPrivacy,
    terms: publicTerms,
    rules: publicRules,
    acceptanceRequired: Boolean(publicPrivacy || publicTerms || publicRules),
    publishedAt: row.createdAt,
  }
}

export async function requireCurrentOnboardingAcceptance(
  env: L4Env,
  revisionId: string | null | undefined,
  accepted: boolean,
): Promise<PublicOnboardingConfig> {
  const current = await loadCurrentOnboarding(env)
  if (!current.acceptanceRequired) return current
  if (!accepted) fail(400, 'acceptance_required', 'Accept the published workspace documents to continue')
  if (!revisionId || revisionId !== current.revisionId) {
    fail(409, 'onboarding_changed', 'The workspace documents changed. Review the current version and try again.')
  }
  return current
}

export async function recordOnboardingAcceptance(env: L4Env, userId: string, revisionId: string | null) {
  if (!revisionId) return
  await getDb(env.DB).insert(onboardingAcceptances).values({
    userId,
    revisionId,
    acceptedAt: nowIso(),
  }).onConflictDoNothing()
}

export async function hasAcceptedCurrentOnboarding(
  env: L4Env,
  userId: string,
  current?: PublicOnboardingConfig,
): Promise<boolean> {
  const onboarding = current ?? await loadCurrentOnboarding(env)
  if (!onboarding.acceptanceRequired || !onboarding.revisionId) return true
  const row = (await getDb(env.DB).select({ userId: onboardingAcceptances.userId })
    .from(onboardingAcceptances)
    .where(and(
      eq(onboardingAcceptances.userId, userId),
      eq(onboardingAcceptances.revisionId, onboarding.revisionId),
    ))
    .limit(1))[0]
  return Boolean(row)
}

export async function createSocialOnboardingTicket(event: H3Event, revisionId: string | null) {
  const { env } = cf(event)
  if (!revisionId) {
    deleteCookie(event, SOCIAL_ACCEPTANCE_COOKIE, { path: '/' })
    return
  }
  const token = newId()
  await env.TICKETS.put(`${SOCIAL_ACCEPTANCE_PREFIX}${token}`, revisionId, { expirationTtl: SOCIAL_ACCEPTANCE_TTL })
  setCookie(event, SOCIAL_ACCEPTANCE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: getRequestURL(event).protocol === 'https:',
    path: '/',
    maxAge: SOCIAL_ACCEPTANCE_TTL,
  })
}

export async function consumeSocialOnboardingTicket(event: H3Event): Promise<string | null> {
  const token = getCookie(event, SOCIAL_ACCEPTANCE_COOKIE)
  if (!token) return null
  const { env } = cf(event)
  deleteCookie(event, SOCIAL_ACCEPTANCE_COOKIE, { path: '/' })
  const key = `${SOCIAL_ACCEPTANCE_PREFIX}${token}`
  const revisionId = await env.TICKETS.get(key)
  await env.TICKETS.delete(key)
  return revisionId
}

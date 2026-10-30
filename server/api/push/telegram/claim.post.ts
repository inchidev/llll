import { getServerId } from '../../../../shared/server-id'
import { z } from 'zod'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { parseBody } from '../../../utils/validate'
import { saveTelegramSubscription, telegramLinkRelay, telegramLinkSecret } from '../../../utils/telegram-subscriptions'

const bodySchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u) }).strict()

/** Collect the delivery token once the person pressed Start; `pending` until then. */
export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const member = await requireMember(event, await getServerId(env.DB))
  const { code } = parseBody(bodySchema, await readBody(event))
  const relay = telegramLinkRelay(env)
  let response: Response
  try {
    response = await fetch(new URL('/api/telegram/links/claim', relay), {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, secret: await telegramLinkSecret(env, member.user.id, code) }),
    })
  } catch { fail(502, 'telegram_unavailable', 'Telegram notifications are unavailable right now') }
  if (response!.status === 410) fail(410, 'link_expired', 'This Telegram link expired. Start again.')
  const body = await response!.json().catch(() => null) as { pending?: unknown; token?: unknown } | null
  if (!response!.ok || !body) fail(502, 'telegram_unavailable', 'Telegram notifications are unavailable right now')
  if (typeof body!.token !== 'string') return { connected: false }
  await saveTelegramSubscription(env, member.user.id, body!.token, relay, getHeader(event, 'user-agent') ?? null)
  return { connected: true }
})

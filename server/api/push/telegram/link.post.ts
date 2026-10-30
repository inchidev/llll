import { getServerId } from '../../../../shared/server-id'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { sha256Hex } from '../../../../shared/server-settings'
import { telegramLinkRelay, telegramLinkSecret } from '../../../utils/telegram-subscriptions'

/**
 * Start pairing Telegram from a browser: register a one-time code with the relay and
 * return the bot link. Pressing Start there lets this Account collect a delivery token.
 */
export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const serverId = await getServerId(env.DB)
  const member = await requireMember(event, serverId)
  const code = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replaceAll('+', '-').replaceAll('/', '_')
  const server = await env.DB.prepare('SELECT name FROM server LIMIT 1').first<{ name: string }>()
  const relay = telegramLinkRelay(env)
  let response: Response
  try {
    response = await fetch(new URL('/api/telegram/links', relay), {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, secretHash: await sha256Hex(await telegramLinkSecret(env, member.user.id, code)), serverId, serverName: (server?.name || 'L4').slice(0, 100) }),
    })
  } catch { fail(502, 'telegram_unavailable', 'Telegram notifications are unavailable right now') }
  const body = await response!.json().catch(() => null) as { bot?: unknown; expiresAt?: unknown } | null
  if (!response!.ok || typeof body?.bot !== 'string' || !/^\w{5,32}$/u.test(body.bot)) fail(502, 'telegram_unavailable', 'Telegram notifications are unavailable right now')
  return { code, url: `https://t.me/${body!.bot}?start=${code}`, expiresAt: body!.expiresAt }
})

import { z } from 'zod'
import {
  APIError,
  createAuthEndpoint,
  getSessionFromCtx,
} from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import {
  verifyMiniAppData,
  verifyTelegramPublicData,
} from '../../shared/telegram'
import type { L4Env } from '../../workers/env'

export function serverTelegram(env: L4Env, registrationMode: string) {
  return {
    id: 'llll-telegram',
    endpoints: {
      telegramMiniApp: createAuthEndpoint(
        '/telegram/miniapp',
        {
          method: 'POST',
          body: z.object({
            initData: z.string().min(1).max(16000),
            link: z.boolean().default(false),
          }),
          requireHeaders: true,
        },
        async (ctx) => {
          if (!env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_TRUSTED_BOT_ID)
            throw new APIError('FORBIDDEN', {
              message: 'Telegram Mini App login is not configured',
            })
          let telegram
          try {
            telegram = env.TELEGRAM_TRUSTED_BOT_ID
              ? await verifyTelegramPublicData(
                  ctx.body.initData,
                  env.TELEGRAM_TRUSTED_BOT_ID,
                )
              : await verifyMiniAppData(
                  ctx.body.initData,
                  env.TELEGRAM_BOT_TOKEN!,
                )
          } catch {
            throw new APIError('UNAUTHORIZED', {
              message: 'Reopen the Telegram Mini App to sign in',
            })
          }
          const current = await getSessionFromCtx(ctx)
          const adapter = ctx.context.internalAdapter
          const key = { providerId: 'telegram', accountId: String(telegram.id) }
          const owner = await adapter.findAccountOwnerByKey(key)
          if (owner?.kind === 'orphaned')
            throw new APIError('CONFLICT', {
              message: 'Telegram account needs recovery',
            })
          if (current) {
            if (owner?.kind === 'owned' && owner.user.id !== current.user.id)
              throw new APIError('CONFLICT', {
                message: 'Telegram is already linked to another account',
              })
            if (!owner && !ctx.body.link)
              throw new APIError('CONFLICT', {
                message: 'Link Telegram explicitly from your account',
              })
            if (ctx.body.link) {
              if (
                Date.now() - new Date(current.session.createdAt).getTime() >
                600000
              )
                throw new APIError('FORBIDDEN', {
                  message: 'Sign in again before linking Telegram',
                })
              const existing = (
                await adapter.findAccounts(current.user.id)
              ).find((account) => account.providerId === 'telegram')
              if (existing && existing.accountId !== key.accountId)
                throw new APIError('CONFLICT', {
                  message: 'Another Telegram account is already linked',
                })
              if (!owner)
                await adapter.linkAccount({ ...key, userId: current.user.id })
            }
            return ctx.json({ ok: true })
          }
          if (ctx.body.link)
            throw new APIError('UNAUTHORIZED', {
              message: 'Sign in before linking Telegram',
            })
          let user = owner?.user
          if (!user) {
            if (registrationMode !== 'open')
              throw new APIError('FORBIDDEN', {
                message: 'Registration is closed',
              })
            const name = [telegram.first_name, telegram.last_name]
              .filter(Boolean)
              .join(' ')
              .slice(0, 100)
            user = (
              await adapter.createOAuthUser(
                {
                  name,
                  email: `telegram-${telegram.id}@identity.llll.invalid`,
                  emailVerified: false,
                  image: telegram.photo_url,
                },
                key,
              )
            ).user
          }
          const session = await adapter.createSession(user.id)
          await setSessionCookie(ctx, { user, session })
          return ctx.json({ ok: true })
        },
      ),
    },
  }
}

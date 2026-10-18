import { sessionAuthFromEvent } from '../../utils/better-auth'
import { cf, fail } from '../../utils/cf'
import { requireUser } from '../../utils/auth'
import { recoveryDigest } from '../../utils/recovery'
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const user = await requireUser(event)
  const session = await (
    await sessionAuthFromEvent(event)
  ).api.getSession({ headers: event.headers })
  if (
    !session ||
    Date.now() - new Date(session.session.createdAt).getTime() > 600000
  )
    fail(
      403,
      'fresh_login_required',
      'Sign in again before replacing your recovery key',
    )
  const code = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  await cf(event)
    .env.DB.prepare(
      'INSERT INTO account_recovery(user_id,code_hash,created_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,created_at=excluded.created_at',
    )
    .bind(user.id, await recoveryDigest(code), Date.now())
    .run()
  return { code }
})

import { z } from 'zod'
import { cf, fail } from '../../utils/cf'
import { ensureMigrated } from '../../utils/db'
import { hashPassword } from '../../utils/password'
import { recoveryDigest } from '../../utils/recovery'
import { parseBody } from '../../utils/validate'
import { clientIp, requireRateLimit } from '../../utils/rate-limit'
const schema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^[a-f0-9]{64}$/),
  password: z.string().min(12).max(200),
})
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const body = parseBody(schema, await readBody(event))
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  await requireRateLimit(event, [
    { key: `ip:${clientIp(event)}:recovery`, limit: 5, windowMs: 60 * 60 * 1000 },
    { key: `account:${body.email.trim().toLowerCase()}:recovery`, limit: 10, windowMs: 60 * 60 * 1000 },
  ], 'Too many recovery attempts')
  const digest = await recoveryDigest(body.code)
  const row = await env.DB.prepare(
    'SELECT r.user_id FROM account_recovery r JOIN auth_users u ON u.id=r.user_id WHERE r.code_hash=? AND u.email=?',
  )
    .bind(digest, body.email.trim().toLowerCase())
    .first<{ user_id: string }>()
  if (!row) fail(401, 'invalid_recovery', 'Recovery key or account is invalid')
  const now = Date.now()
  const password = await hashPassword(body.password)
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at) SELECT ?,user_id,'credential',user_id,?,?,? FROM account_recovery WHERE code_hash=? AND user_id=? ON CONFLICT(provider_id,account_id) DO UPDATE SET password=excluded.password,updated_at=excluded.updated_at",
    ).bind(crypto.randomUUID(), password, now, now, digest, row.user_id),
    env.DB.prepare(
      'DELETE FROM auth_sessions WHERE user_id IN (SELECT user_id FROM account_recovery WHERE code_hash=? AND user_id=?)',
    ).bind(digest, row.user_id),
    env.DB.prepare(
      'DELETE FROM account_recovery WHERE code_hash=? AND user_id=? RETURNING user_id',
    ).bind(digest, row.user_id),
  ])
  if (!results[2]?.results?.length)
    fail(401, 'invalid_recovery', 'Recovery key was already used')
  return { ok: true }
})

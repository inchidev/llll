import type { H3Event } from 'h3'
import { ensureAdminFromEnv } from './bootstrap'
import { cf } from './cf'
import { ensureMigrated } from './db'
import { readOwnerSetup } from './owner-setup'
import { ensurePrimaryServerOrigin } from './server-origins'

const started = new WeakMap<D1Database, Promise<boolean>>()

/**
 * Workers have no startup hook with bindings, so the first request an isolate
 * serves (whatever its method or path) initialises the Server once: the
 * schema bootstrap/check, the optional `ADMIN_*` env owner, the legacy env
 * owner claim and the configured primary origin. Every input comes from
 * deployment configuration, never from the request. Handlers such as
 * `GET /api/setup/health` therefore stay read-only.
 *
 * A failure (for example celld before its migrations are applied) is not
 * fatal to the request and is retried by the isolate's next request.
 */
export function ensureServerStarted(event: H3Event): Promise<boolean> {
  let env
  try { env = cf(event).env }
  catch { return Promise.resolve(false) }
  const db = env.DB
  const existing = started.get(db)
  if (existing) return existing
  const run = (async () => {
    await ensureMigrated(db, env)
    await ensureAdminFromEnv(event)
    await readOwnerSetup(db, env)
    await ensurePrimaryServerOrigin(env)
    return true
  })().catch((error: unknown) => {
    started.delete(db)
    console.warn('Server startup did not complete', error instanceof Error ? error.message : error)
    return false
  })
  started.set(db, run)
  return run
}

import type { H3Event } from 'h3'
import { ensureAdminFromEnv } from './bootstrap'
import { cf } from './cf'
import { ensureMigrated } from './db'
import { readOwnerSetup } from './owner-setup'
import { ensurePrimaryServerOrigin } from './server-origins'
import { bindingIdentity } from '../../shared/binding-identity'

const started = new WeakMap<D1Database, Promise<boolean>>()
/** Settled starts, so a stall report can say whether startup was what a request waited on. */
const finished = new WeakSet<D1Database>()

/**
 * The longest a request waits for startup. A database call that never answers would otherwise hold
 * every request this isolate serves until Cloudflare retires it, which took about ten minutes on a
 * Preview after a deploy. A fresh database bootstraps in seconds.
 */
export const STARTUP_WAIT_MS = 30_000

export function serverStartupSettled(db: D1Database | undefined) {
  return Boolean(db && finished.has(bindingIdentity(db)))
}

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
  const db = env.DB, key = bindingIdentity(db)
  if (finished.has(key)) return started.get(key) ?? Promise.resolve(true)
  let run = started.get(key)
  if (!run) {
    const attempt: Promise<boolean> = (async () => {
      await ensureMigrated(db, env)
      await ensureAdminFromEnv(event)
      await readOwnerSetup(db, env)
      await ensurePrimaryServerOrigin(env)
      finished.add(key)
      return true
    })().catch((error: unknown) => {
      if (started.get(key) === attempt) started.delete(key)
      console.warn('Server startup did not complete', error instanceof Error ? error.message : error)
      return false
    })
    started.set(key, run = attempt)
  }
  return waitForStartup(key, run)
}

/** Waits for a start, but never longer than STARTUP_WAIT_MS: then the next request tries again. */
function waitForStartup(key: D1Database, run: Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      if (started.get(key) === run) started.delete(key)
      console.warn('server.startup.stalled', { waitedMs: STARTUP_WAIT_MS })
      resolve(false)
    }, STARTUP_WAIT_MS)
  })
  return Promise.race([run, stalled]).finally(() => clearTimeout(timer))
}

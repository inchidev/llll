import type { H3Event } from 'h3'
import { ensureAdminFromEnv } from './bootstrap'
import { cf } from './cf'
import { ensureMigrated } from './db'
import { readOwnerSetup } from './owner-setup'
import { ensurePrimaryServerOrigin } from './server-origins'
import { bindingIdentity } from '../../shared/binding-identity'

/** When the running start began. Not its promise: a promise belongs to the request that made it, and never settles once that request ends. */
const running = new WeakMap<D1Database, number>()
/** Settled starts, so a stall report can say whether startup was what a request waited on. */
const finished = new WeakSet<D1Database>()

/**
 * The longest a request waits for startup. A database call that never answers would otherwise hold
 * every request this isolate serves until Cloudflare retires it, which took about ten minutes on a
 * Preview after a deploy. A fresh database bootstraps in seconds.
 */
export const STARTUP_WAIT_MS = 30_000
/** How long a request waits on another request's start before running its own, as that request may be gone. */
export const STARTUP_TAKEOVER_MS = 2_000
const STARTUP_POLL_MS = 20

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
export async function ensureServerStarted(event: H3Event): Promise<boolean> {
  let env
  try { env = cf(event).env }
  catch { return false }
  const db = env.DB, key = bindingIdentity(db)
  while (!finished.has(key)) {
    const since = running.get(key)
    if (since === undefined || Date.now() - since >= STARTUP_TAKEOVER_MS) return waitForStartup(key, startServer(event, db, env, key))
    await new Promise(resolve => setTimeout(resolve, STARTUP_POLL_MS))
  }
  return true
}

/** One round trip: a Server that already has its schema and people has nothing a request must wait for. */
async function alreadySetUp(db: D1Database) {
  try {
    const [schema, home, people] = await db.batch<{ version?: string, c?: number }>([
      db.prepare('SELECT version FROM server_schema WHERE id = 1'),
      db.prepare('SELECT 1 AS c FROM server LIMIT 1'),
      db.prepare("SELECT 1 AS c FROM users WHERE status = 'active' LIMIT 1"),
    ])
    return schema?.results?.[0]?.version === 'server-v1' && Boolean(home?.results?.[0]) && Boolean(people?.results?.[0])
  }
  catch { return false } // A database before its first migration has no such tables.
}

function startServer(event: H3Event, db: D1Database, env: ReturnType<typeof cf>['env'], key: D1Database): Promise<boolean> {
  const startedAt = Date.now()
  running.set(key, startedAt)
  const initialise = async () => {
    await ensureMigrated(db, env)
    await ensureAdminFromEnv(event)
    await readOwnerSetup(db, env)
    await ensurePrimaryServerOrigin(env)
  }
  return (async () => {
    // Every new isolate comes here, and Cloudflare starts them often. The checks and
    // deployment settings still run for each one, only no longer in front of the person.
    if (await alreadySetUp(db)) {
      finished.add(key)
      cf(event).waitUntil(initialise().catch((error: unknown) => {
        console.warn('Server startup did not complete', error instanceof Error ? error.message : error)
      }))
      return true
    }
    await initialise()
    finished.add(key)
    return true
  })().catch((error: unknown) => {
    console.warn('Server startup did not complete', error instanceof Error ? error.message : error)
    return false
  }).finally(() => {
    if (running.get(key) === startedAt) running.delete(key)
  })
}

/** Waits for this request's start, but never longer than STARTUP_WAIT_MS: then the next request tries again. */
function waitForStartup(key: D1Database, run: Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      running.delete(key)
      console.warn('server.startup.stalled', { waitedMs: STARTUP_WAIT_MS })
      resolve(false)
    }, STARTUP_WAIT_MS)
  })
  return Promise.race([run, stalled]).finally(() => clearTimeout(timer))
}

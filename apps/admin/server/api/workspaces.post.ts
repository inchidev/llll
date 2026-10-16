import { adminEnv, assertMutation, fail, progressStream } from '../utils/http'
import { requireOwner } from '../utils/session'
import { createWorkspace } from '../utils/workspaces'

/** Create a workspace linked to this Admin. Progress streams as NDJSON. */
export default defineEventHandler(async (event) => {
  assertMutation(event)
  const owner = await requireOwner(event)
  const body = await readBody<{ workerName?: unknown, appName?: unknown, filesEnabled?: unknown, forMyself?: unknown, ownerEmail?: unknown }>(event) ?? {}
  if (body.forMyself !== undefined && typeof body.forMyself !== 'boolean') fail(400, 'Choose whether this workspace is for you')
  // Older clients create workspaces for the signed-in Admin owner by default.
  let ownerEmail = owner.email
  if (body.forMyself === false) ownerEmail = typeof body.ownerEmail === 'string' ? body.ownerEmail.trim().toLowerCase() : ''
  if (ownerEmail.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(ownerEmail)) fail(400, 'Enter a valid workspace owner email')
  const env = adminEnv(event)
  return progressStream(event, report => createWorkspace(env, { ...body, ownerEmail }, report))
})

import { eq } from 'drizzle-orm'
import { invites, workspace } from '../../../drizzle/schema'
import { WORKSPACE_ID } from '../../../shared/ids'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const code = getRouterParam(event, 'code')!
  const { env } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select({
    code: invites.code,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    expiresAt: invites.expiresAt,
    uses: invites.uses,
    maxUses: invites.maxUses,
  }).from(invites).innerJoin(workspace, eq(workspace.id, WORKSPACE_ID)).where(eq(invites.code, code)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Invite not found')
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) fail(410, 'expired', 'Invite expired')
  if (row.maxUses > 0 && row.uses >= row.maxUses) fail(410, 'exhausted', 'Invite already used')
  return { invite: row }
})

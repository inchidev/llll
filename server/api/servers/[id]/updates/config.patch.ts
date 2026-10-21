import { z } from 'zod'
import { encryptSecret } from '../../../../../shared/encrypted-secret'
import { activeUpdate, changeUpdateRecord, updateHookId } from '../../../../../shared/server-updates'
import { authSecret } from '../../../../utils/auth-config'
import { fail } from '../../../../utils/cf'
import { updateOwner, updateStorage } from '../../../../utils/server-updates'
import { parseBody } from '../../../../utils/validate'

export default defineEventHandler(async (event) => {
  const { env, serverId } = await updateOwner(event)
  const body = parseBody(z.object({ hook: z.string().trim().max(500) }), await readBody(event))
  let hook: string
  try { hook = updateHookId(body.hook) } catch { return fail(400, 'invalid_build_hook', 'Enter a Cloudflare Workers Build deploy hook URL or ID') }
  const encrypted = await encryptSecret(authSecret(env, getRequestURL(event).origin), `server-update-hook:${serverId}`, hook)
  await changeUpdateRecord(updateStorage(env, serverId), (record) => {
    if (activeUpdate(record.job)) fail(409, 'update_active', 'Wait for the current update before changing its Build hook')
    record.hook = encrypted
  })
  return { configured: true }
})

import { z } from 'zod'
import { changeUpdateRecord } from '../../../../../shared/server-updates'
import { updateOwner, updateStorage } from '../../../../utils/server-updates'
import { parseBody } from '../../../../utils/validate'
import { fail } from '../../../../utils/cf'

export default defineEventHandler(async event => {
  const { env, serverId } = await updateOwner(event)
  const body = parseBody(z.object({ requestId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), sizeBytes: z.number().int().positive() }), await readBody(event))
  await changeUpdateRecord(updateStorage(env, serverId), record => {
    const backup = record.job?.backup
    if (record.job?.id !== body.requestId || record.job.stage !== 'queued' || backup?.destination !== 'download'
      || backup.sha256 !== body.sha256 || backup.sizeBytes !== body.sizeBytes) fail(409, 'backup_mismatch', 'The downloaded backup did not match the complete Server archive. Download it again.')
    backup.verified = true
    record.job.updatedAt = new Date().toISOString()
  })
  return { ok: true }
})

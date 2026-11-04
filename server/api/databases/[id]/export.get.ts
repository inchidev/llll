import { z } from 'zod'
import { Permission } from '../../../../shared/permissions'
import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { validCalendarRange } from '../../../utils/database-views'
import { exportDatabaseCsv } from '../../../utils/data-transfer'
import { parseBody } from '../../../utils/validate'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.readData)
  const query = parseBody(z.object({ viewId: z.string().optional(), search: z.string().max(500).optional(), dateFrom: z.string().date().optional(), dateTo: z.string().date().optional(), spreadsheetSafe: z.enum(['true', 'false']).default('true') }).refine(query => Boolean(query.dateFrom) === Boolean(query.dateTo) && (!query.dateFrom || !query.dateTo || validCalendarRange(query.dateFrom, query.dateTo)), 'Invalid calendar range'), getQuery(event))
  const csv = await exportDatabaseCsv(env, actor.authorization, getRouterParam(event, 'id')!, { ...query, spreadsheetSafe: query.spreadsheetSafe === 'true' })
  setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
  setHeader(event, 'Content-Disposition', 'attachment; filename="records.csv"')
  return csv
})

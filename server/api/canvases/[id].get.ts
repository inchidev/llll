import { getServerId } from '../../../shared/server-id'
import { Permission } from '../../../shared/permissions'
import type { CanvasDTO } from '../../../shared/types'
import { cf } from '../../utils/cf'
import { loadCanvas } from '../../utils/data-resources'
import { requireMember } from '../../utils/guards'

export default defineEventHandler(async (event): Promise<{ canvas: CanvasDTO }> => {
  await requireMember(event, (await getServerId(cf(event).env.DB)), Permission.manageDatabases)
  const canvas = await loadCanvas(cf(event).env, getRouterParam(event, 'id')!)
  return { canvas }
})

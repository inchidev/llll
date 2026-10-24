import { aiFunctionCatalog } from '../../../utils/ai-functions'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'

export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  setHeader(event, 'Cache-Control', 'no-store')
  const catalog = await aiFunctionCatalog(cf(event).env, actor.user.id)
  if (!actor.isOwner) return { functions: catalog.functions.map(({ id, available }) => ({ id, available })) }
  const search = String(getQuery(event).search ?? '').slice(0, 160).toLowerCase()
  const named = catalog.models.filter(model => model.value.startsWith('l4:'))
  const matched = named.filter(model => `${model.provider} ${model.label}`.toLowerCase().includes(search))
  const selected = named.filter(model => catalog.functions.some(entry => entry.model === model.value))
  return { functions: catalog.functions, models: [...new Map([...selected, ...matched.slice(0, 50)].map(model => [model.value, model])).values()], hasMore: matched.length > 50 }
})

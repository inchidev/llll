import { workersAiModels } from '../../shared/workers-ai-models'
import { readServerSetting } from '../../shared/server-settings'
import { aiProvider, resolveAgentModelId, type L4Env } from '../../workers/env'
import type { AgentModelOption } from '../../shared/agent-providers'

/** Search a bounded model page without hydrating every connection or its encrypted credentials. */
export async function agentModelOptions(env: L4Env, actorId: string, search = '', selected?: string | null) {
  const name = "COALESCE(json_extract(p.value,'$.name'), CASE substr(p.key,17) WHEN 'anthropic' THEN 'Claude' WHEN 'openrouter' THEN 'OpenRouter' ELSE substr(p.key,17) END)"
  const projection = `('l4:'||substr(p.key,17)||':'||json_extract(m.value,'$.id')) as value,COALESCE(json_extract(m.value,'$.label'),json_extract(m.value,'$.id')) as label,${name} as provider`
  const from = `FROM server_settings p,json_each(p.value,'$.models') m WHERE p.key LIKE 'agents.provider.%' AND COALESCE(json_extract(p.value,'$.kind'),substr(p.key,17)) IN ('openrouter','anthropic','chatgpt') AND json_extract(p.value,'$.enabled')=1 AND json_type(p.value,'$.secret')='object' AND (json_extract(p.value,'$.kind') IS NOT 'chatgpt' OR json_extract(p.value,'$.connectedBy')=?)`
  const query = async (condition: string, args: unknown[], limit: number, order = `lower(${name}),json_extract(m.value,'$.id')`) => (await env.DB.prepare(`SELECT ${projection} ${from} AND (${condition}) ORDER BY ${order} LIMIT ${limit}`).bind(actorId, ...args).all<AgentModelOption>()).results
  const configuredDefault = await readServerSetting(env.DB, 'agents.defaultModel')
  const defaults = configuredDefault ? await query("('l4:'||substr(p.key,17)||':'||json_extract(m.value,'$.id'))=?", [configuredDefault], 1) : []
  const first = defaults[0] ?? (await query('1', [], 1, 'p.key,CAST(m.key AS INTEGER)'))[0]
  const rows = await query(`instr(lower(${name}||' '||COALESCE(json_extract(m.value,'$.label'),'')||' '||json_extract(m.value,'$.id')),?)>0`, [search.toLowerCase()], 51)
  const models = rows.slice(0, 50)
  const selectedOption = selected ? (await query("('l4:'||substr(p.key,17)||':'||json_extract(m.value,'$.id'))=? OR json_extract(m.value,'$.id')=?", [selected, selected], 1))[0] : first
  if (selectedOption && !models.some(m => m.value === selectedOption.value)) models.unshift(selectedOption)
  const imported = await env.DB.prepare("SELECT key FROM server_settings WHERE key LIKE 'agents.provider.%' AND json_type(value,'$.secret')='object' AND (json_extract(value,'$.kind')='openrouter' OR key='agents.provider.openrouter') LIMIT 1").first()
  const deployment = aiProvider(env) && !(imported && env.AI_BASE_URL?.replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1') ? resolveAgentModelId(env) : null
  if (deployment && aiProvider(env) !== 'openai-compatible') {
    for (const model of workersAiModels) if (!search || `${model.id} ${model.label}`.toLowerCase().includes(search.toLowerCase()) || selected === model.id) models.push({ value: model.id, label: model.label, provider: 'Workers AI' })
  }
  if (deployment && !models.some(m => m.value === deployment) && (!search || deployment.toLowerCase().includes(search.toLowerCase()) || selected === deployment || configuredDefault === deployment)) models.push({ value: deployment, label: deployment, provider: 'Deployment' })
  if (deployment && selected && !selected.startsWith('l4:') && aiProvider(env) === 'openai-compatible' && !selected.startsWith('@cf/') && !models.some(m => m.value === selected)) models.unshift({ value: selected, label: selected, provider: 'Deployment' })
  return { models, defaultModel: configuredDefault === deployment ? deployment : first?.value ?? deployment, hasMore: rows.length > 50 }
}

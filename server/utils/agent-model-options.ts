import { agentProviderKey, deploymentDefaultModel } from './agent-providers'
import { workersAiModels } from '../../shared/workers-ai-models'
import { readServerSetting } from '../../shared/server-settings'
import { aiProvider, resolveAgentModelId, type L4Env } from '../../workers/env'
import { parseAgentModelRef, type AgentModelOption } from '../../shared/agent-providers'
import { fail } from './cf'

/** Search a bounded model page without hydrating every connection or its encrypted credentials. */
export async function agentModelOptions(env: L4Env, actorId: string, search = '', selected?: string | null) {
  const name = "COALESCE(json_extract(p.value,'$.name'), CASE substr(p.key,17) WHEN 'anthropic' THEN 'Claude' WHEN 'openrouter' THEN 'OpenRouter' ELSE substr(p.key,17) END)"
  const projection = `('l4:'||substr(p.key,17)||':'||json_extract(m.value,'$.id')) as value,COALESCE(json_extract(m.value,'$.label'),json_extract(m.value,'$.id')) as label,${name} as provider,json_extract(m.value,'$.inputs') as inputs,json_extract(m.value,'$.reasoning') as reasoning`
  const from = `FROM server_settings p,json_each(p.value,'$.models') m WHERE p.key LIKE 'agents.provider.%' AND COALESCE(json_extract(p.value,'$.kind'),substr(p.key,17)) IN ('openrouter','anthropic','chatgpt') AND json_extract(p.value,'$.enabled')=1 AND json_type(p.value,'$.secret')='object' AND json_extract(m.value,'$.tools') IS NOT 0 AND (json_extract(p.value,'$.kind') IS NOT 'chatgpt' OR json_extract(p.value,'$.connectedBy')=?)`
  type Row = Omit<AgentModelOption, 'inputs' | 'reasoning'> & { inputs: string | null; reasoning: number | null }
  const query = async (condition: string, args: unknown[], limit: number, order = `lower(${name}),json_extract(m.value,'$.id')`): Promise<AgentModelOption[]> => (await env.DB.prepare(`SELECT ${projection} ${from} AND (${condition}) ORDER BY ${order} LIMIT ${limit}`).bind(actorId, ...args).all<Row>()).results
    .map(({ inputs, reasoning, ...row }) => ({ ...row, ...(inputs ? { inputs: JSON.parse(inputs) as AgentModelOption['inputs'] } : {}), ...(reasoning !== null ? { reasoning: Boolean(reasoning) } : {}) }))
  const [configuredDefault, rows, imported] = await Promise.all([
    readServerSetting(env.DB, 'agents.defaultModel'),
    query(`instr(lower(${name}||' '||COALESCE(json_extract(m.value,'$.label'),'')||' '||json_extract(m.value,'$.id')),?)>0`, [search.toLowerCase()], 51),
    env.DB.prepare("SELECT key FROM server_settings WHERE key LIKE 'agents.provider.%' AND json_type(value,'$.secret')='object' AND (json_extract(value,'$.kind')='openrouter' OR key='agents.provider.openrouter') LIMIT 1").first(),
  ])
  const [defaults, selections] = await Promise.all([
    configuredDefault ? query("('l4:'||substr(p.key,17)||':'||json_extract(m.value,'$.id'))=?", [configuredDefault], 1) : [],
    selected ? query("('l4:'||substr(p.key,17)||':'||json_extract(m.value,'$.id'))=? OR json_extract(m.value,'$.id')=?", [selected, selected], 1) : [],
  ])
  const first = defaults[0]
  const models = rows.slice(0, 50)
  const selectedOption = selections[0] ?? first
  if (selectedOption && !models.some(m => m.value === selectedOption.value)) models.unshift(selectedOption)
  const importedDeployment = Boolean(imported && env.AI_BASE_URL?.replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1')
  const deployment = aiProvider(env) && !importedDeployment ? resolveAgentModelId(env) : null
  if (deployment && aiProvider(env) !== 'openai-compatible') {
    for (const model of workersAiModels) if (!search || `${model.id} ${model.label}`.toLowerCase().includes(search.toLowerCase()) || selected === model.id || configuredDefault === model.id) models.push({ value: model.id, label: model.label, provider: 'Workers AI' })
  }
  if (deployment && !models.some(m => m.value === deployment) && (!search || deployment.toLowerCase().includes(search.toLowerCase()) || selected === deployment || configuredDefault === deployment)) models.push({ value: deployment, label: deployment, provider: 'Deployment' })
  if (deployment && selected && !selected.startsWith('l4:') && aiProvider(env) === 'openai-compatible' && !selected.startsWith('@cf/') && !models.some(m => m.value === selected)) models.unshift({ value: selected, label: selected, provider: 'Deployment' })
  return { models, defaultModel: configuredDefault !== null ? models.find(model => model.value === configuredDefault)?.value ?? null : deploymentDefaultModel(env, models, importedDeployment), deploymentProvider: deployment ? (aiProvider(env) === 'openai-compatible' ? 'Deployment' : 'Workers AI') : null, hasMore: rows.length > 50 }
}

/** Agents work through tools. A model the provider marks as text-only stays available for AI functions only. */
export async function assertAgentModelSupportsTools(env: L4Env, model: string) {
  const ref = parseAgentModelRef(model)
  if (!ref) return
  const textOnly = await env.DB.prepare(`SELECT 1 AS found FROM server_settings p, json_each(p.value,'$.models') m
    WHERE p.key=? AND json_extract(m.value,'$.id')=? AND json_extract(m.value,'$.tools') IS 0 LIMIT 1`)
    .bind(agentProviderKey(ref.provider), ref.model).first()
  if (textOnly) fail(400, 'model_without_tools', 'This model does not support tools, which agents need. Choose another model; this one remains available for AI functions.')
}

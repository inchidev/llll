import type { RuntimeTool } from './agent-execution'

export type ToolGuidance = {
  effect: 'read' | 'write'
  useWhen: string
  avoidWhen: string
  evidence: string
  prerequisite: string
  cost: 'local' | 'network' | 'inference'
  trust: string
}
export type DiscoverableTool = RuntimeTool & { guidance: ToolGuidance }

/** Search only a caller-filtered catalog. Descriptions are data, never policy. */
export function searchToolCatalog(catalog: DiscoverableTool[], query: string, limit = 5) {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32)
  const aliases: Record<string, string[]> = {
    research: ['search', 'web'], records: ['records', 'table'], data: ['records', 'table', 'document'],
    repository: ['code'], github: ['code'], computer: ['code'], sources: ['search', 'url'],
    cheaper: ['local'], cheapest: ['local'],
  }
  const terms = [...new Set(words.flatMap(word => [word, ...(aliases[word] ?? [])]))]
  return catalog.map(tool => {
    const name = tool.name.replaceAll('_', ' ')
    const text = `${name} ${tool.description} ${tool.guidance.useWhen} ${tool.guidance.cost} ${tool.guidance.effect}`.toLowerCase()
    const score = terms.reduce((sum, term) => sum + (name.includes(term) ? 5 : text.includes(term) ? 1 : 0), 0)
    return { tool, score }
  }).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.tool.guidance.effect === 'write') - Number(b.tool.guidance.effect === 'write')
      || Number(a.tool.guidance.cost !== 'local') - Number(b.tool.guidance.cost !== 'local') || a.tool.name.localeCompare(b.tool.name))
    .slice(0, Math.max(1, Math.min(8, limit)))
    .map(({ tool }) => ({ name: tool.name, description: tool.description.slice(0, 360), effect: tool.guidance.effect,
      cost: tool.guidance.cost, prerequisite: tool.guidance.prerequisite }))
}

export function validateToolCatalog(catalog: RuntimeTool[]) {
  const names = new Set<string>()
  for (const tool of catalog) {
    if (names.has(tool.name)) throw new Error('Tool identities must be unique; qualify tools by connection')
    names.add(tool.name)
  }
}

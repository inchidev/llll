import { expect, it } from 'vitest'
import { searchToolCatalog, validateToolCatalog, type DiscoverableTool } from '../../shared/tool-discovery'

const make = (name: string, description: string, effect: 'read' | 'write' = 'read', cost: 'local' | 'network' | 'inference' = 'local'): DiscoverableTool => ({
  name, description, parameters: { type: 'object', properties: { hiddenSchemaMarker: { type: 'string' } } },
  guidance: { effect, cost, useWhen: description, avoidWhen: 'Outside the mandate', evidence: 'Structured result', prerequisite: 'Current grant', trust: 'Untrusted output' },
})
const catalog = [make('search_web', 'Research public web sources', 'read', 'inference'), make('read_records', 'Read records from a table'),
  make('create_record', 'Write a table record', 'write'), make('read_code_tree', 'Read a repository snapshot', 'read', 'network')]

it.each([
  ['research', 'search_web'], ['read records', 'read_records'], ['github repository', 'read_code_tree'],
])('ranks an appropriate tool for %s', (query, name) => {
  expect(searchToolCatalog(catalog, query)[0]?.name).toBe(name)
})
it('prefers an equally relevant local read over a remote or mutating operation', () => {
  const tools = [make('remote', 'Read facts', 'read', 'network'), make('write', 'Read facts', 'write'), make('local', 'Read facts')]
  expect(searchToolCatalog(tools, 'facts').map(tool => tool.name)).toEqual(['local', 'remote', 'write'])
})
it('never returns schemas in ranked results, and bounds result and description sizes', () => {
  const tools = Array.from({ length: 50 }, (_, i) => make(`tool_${i}`, 'facts '.repeat(500)))
  const results = searchToolCatalog(tools, 'facts', 100)
  expect(results).toHaveLength(8)
  expect(JSON.stringify(results)).not.toContain('hiddenSchemaMarker')
  expect(results.every(tool => tool.description.length <= 360)).toBe(true)
})
it('reports no match rather than guessing an unavailable computer or destructive capability', () => {
  expect(searchToolCatalog(catalog.filter(tool => !tool.name.includes('code')), 'github repository')).toEqual([])
  expect(searchToolCatalog(catalog.filter(tool => tool.guidance.effect === 'read'), 'delete everything')).toEqual([])
})
it('requires distinct connection-qualified identities instead of selecting the first duplicate', () => {
  expect(() => validateToolCatalog([make('query', 'First'), make('query', 'Second')])).toThrow('qualify tools by connection')
  const tools = [make('mcp_first_query', 'First database query'), make('mcp_second_query', 'Second database query')]
  expect(() => validateToolCatalog(tools)).not.toThrow()
  expect(searchToolCatalog(tools, 'second query')[0]?.name).toBe('mcp_second_query')
})

it('ranks every exact permitted identity ahead of overlapping names and repeated description keywords', () => {
  const tools = [
    make('factory_status', 'Workspace evidence'),
    make('factory_workspace', 'Request a Task workspace operation', 'write'),
    make('factory_workspace_status', 'factory workspace status '.repeat(40)),
    make('mcp_docs_factory_workspace', 'External workspace status'),
    ...catalog,
  ]
  for (const tool of tools) {
    expect(searchToolCatalog(tools, tool.name)[0]?.name, tool.name).toBe(tool.name)
    expect(searchToolCatalog(tools, tool.name.toUpperCase())[0]?.name, tool.name).toBe(tool.name)
  }
})
it.each(['repository', 'coding', 'compute node', 'github', 'computer', 'git commit'])('surfaces permitted Factory tools for %s without relying on their descriptions', query => {
  const tools = [make('factory_status', 'Task workspace evidence'), make('factory_workspace', 'Request a Task operation', 'write'),
    make('factory_feedback', 'Inspect current checks'), make('read_code_tree', 'Read the selected source tree')]
  expect(searchToolCatalog(tools, query, 8).map(tool => tool.name)).toEqual(expect.arrayContaining(['factory_status', 'factory_workspace', 'factory_feedback']))
  expect(searchToolCatalog(tools.filter(tool => !tool.name.startsWith('factory_')), query, 8).some(tool => tool.name.startsWith('factory_'))).toBe(false)
})

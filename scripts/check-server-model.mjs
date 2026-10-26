import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '..')
// These sources use a coding workspace, not the retired community/account domain.
// Keep the exception local to the integrated factory and its exact vocabulary.
const codingWorkspaceSources = new Set([
  'app/components/agents/FactoryReview.vue', 'app/components/settings/ComputeNodes.vue',
  'app/components/settings/ToolsSettings.vue', 'app/pages/runs/[id].vue',
  'server/utils/agent-tool-security.ts', 'server/utils/agent-tools.ts', 'server/utils/compute-nodes.ts',
  'server/utils/factory-actions.ts', 'server/utils/factory-authority.ts', 'server/utils/factory-github.ts',
  'server/utils/factory-status.ts', 'server/utils/github-agent-client.ts',
  'shared/software-factory.ts', 'shared/workspace-provider.ts', 'workers/agent-pi-durable.ts',
  'drizzle/server-migrations/0023_software_factory.sql',
])
export function usesRetiredProductTerms(path, text) {
  // GitHub App provider IDs are distinct from the retired product domain.
  let productText = (path + '\n' + text).replace(/\b(?:(?:source|work)InstallationId|installationId)\b|\/app\/installations(?:\/|\?)|\/installation\/(?:token|repositories)|\/installations\/new/g, 'GitHubProviderId')
  if (codingWorkspaceSources.has(path)) {
    productText = productText.replace(/\b(?:[Ff]actoryWorkspace|factory_workspaces|factory_workspace|[Ww]orkspace(?:Id|Revision|Columns|Request|Provider|Receipt|Job)?|workspace_(?:id|failed|ready|exists|unavailable))\b/g, 'CodingCheckout')
  }
  return /workspace|installation|apps\/instance/i.test(productText) || /\bInstance\b/.test(productText)
}
async function scan(directory, violations) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = directory + '/' + entry.name
    if (entry.isDirectory()) { await scan(path, violations); continue }
    if (!/\.(?:ts|vue|mjs|sql|json|jsonc|md)$/.test(path)) continue
    const text = await readFile(resolve(root, path), 'utf8')
    if (usesRetiredProductTerms(path, text)) violations.push(path)
  }
}
export async function checkServerModel() {
  const violations = []
  for (const directory of ['app', 'server', 'shared', 'workers', 'drizzle', 'packages/deployment-core/src', 'apps/site/app', 'apps/site/src']) await scan(directory, violations)
  if (violations.length) throw new Error('Retired product terminology in active sources: ' + violations.join(', '))
  console.log('Server model: active sources and schema use only the current domain')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkServerModel()

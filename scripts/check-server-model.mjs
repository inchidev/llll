import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '..')
// These sources use a coding workspace, not the retired community/account domain.
// Keep the exception local to the integrated factory and its exact vocabulary.
const codingWorkspaceSources = new Set([
  'app/components/settings/ComputeNodes.vue', 'packages/deployment-core/src/factory.ts',
  // The schema's history: the per-command tables a fresh database creates and the box migration drops.
  'drizzle/server-migrations/0000_baseline.sql', 'drizzle/server-migrations/0004_agent_box.sql',
  'server/shims.d.ts',
  // Stored execution policies may still carry the per-command limits; they are dropped on read.
  'shared/agent-execution-policy.ts',
])
// The product line describes shared work; it never names a Server identity.
const productDescriptionSources = new Set(['app/app.vue', 'shared/app-branding.ts'])
export function usesRetiredProductTerms(path, text) {
  // GitHub App provider IDs are distinct from the retired product domain.
  let productText = (path + '\n' + text).replace(/\b(?:(?:source|work)InstallationId|installationId)\b|\/app\/installations(?:\/|\?)|\/installation\/(?:token|repositories)|\/installations\/new/g, 'GitHubProviderId')
  if (codingWorkspaceSources.has(path)) {
    productText = productText.replace(/\b(?:factory_workspaces|LLLL_WORKSPACE_(?:IMAGE|DISK_BYTES)|Dockerfile\.workspace|[Ww]orkspaces?(?:Actions|RuntimeMs|Publications)?|workspace_id)\b/g, 'CodingCheckout')
  }
  if (productDescriptionSources.has(path)) productText = productText.replace(/\bworkspaces?\b/gi, 'SharedWork')
  return /workspace|installation|apps\/instance/i.test(productText) || /\bInstance\b/.test(productText)
}
async function scan(directory, violations) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = directory + '/' + entry.name
    // Generated from drizzle/schema.ts, which is checked itself.
    if (path === 'drizzle/server-migrations/meta') continue
    if (entry.isDirectory()) { await scan(path, violations); continue }
    if (!/\.(?:ts|vue|mjs|sql|json|jsonc|md)$/.test(path)) continue
    const text = await readFile(resolve(root, path), 'utf8')
    if (usesRetiredProductTerms(path, text)) violations.push(path)
  }
}
export async function checkServerModel() {
  const violations = []
  for (const directory of ['app', 'server', 'shared', 'workers', 'drizzle', 'packages/deployment-core/src']) await scan(directory, violations)
  if (violations.length) throw new Error('Retired product terminology in active sources: ' + violations.join(', '))
  console.log('Server model: active sources and schema use only the current domain')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkServerModel()

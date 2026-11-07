import { expect, it } from 'vitest'
import { usesRetiredProductTerms } from '../../scripts/check-server-model.mjs'

it('allows the per-command Factory’s names only where its history and stored settings remain', () => {
  expect(usesRetiredProductTerms('drizzle/server-migrations/0004_agent_box.sql', 'DROP TABLE `factory_workspaces`')).toBe(false)
  expect(usesRetiredProductTerms('shared/agent-execution-policy.ts', 'workspaceActions workspaceRuntimeMs workspacePublications')).toBe(false)
  expect(usesRetiredProductTerms('server/utils/authorization.ts', 'factory_workspaces')).toBe(true)
  // The box replaced the per-command checkout: its identifiers may not come back.
  for (const text of ['factory_workspace', 'FactoryWorkspace', 'workspaceId', 'WorkspaceProvider', 'workspace_ready'])
    expect(usesRetiredProductTerms('server/utils/factory-boxes.ts', text), text).toBe(true)
})
it('still rejects retired community models and new compound identifiers inside allowed sources', () => {
  for (const text of ['workspace_members', 'WorkspaceAdminRole', 'installation', 'Instance', 'apps/instance']) {
    expect(usesRetiredProductTerms('drizzle/server-migrations/0000_baseline.sql', text), text).toBe(true)
  }
})
it('keeps existing narrow GitHub provider exceptions without allowing installation products', () => {
  expect(usesRetiredProductTerms('server/utils/git-connections.ts', 'installationId sourceInstallationId workInstallationId /app/installations/ /installation/token /installation/repositories /installations/new')).toBe(false)
  expect(usesRetiredProductTerms('server/utils/git-connections.ts', 'installationMembers')).toBe(true)
})

it('allows the public workspace description without reviving workspace identity models', () => {
  expect(usesRetiredProductTerms('app/app.vue', 'One workspace for humans and agents. Isolated task workspaces.')).toBe(false)
  expect(usesRetiredProductTerms('app/app.vue', 'workspace_members')).toBe(true)
  expect(usesRetiredProductTerms('app/app.vue', 'One workspace for humans and agents.')).toBe(false)
  expect(usesRetiredProductTerms('shared/app-branding.ts', 'WorkspaceAdminRole')).toBe(true)
  expect(usesRetiredProductTerms('server/utils/authorization.ts', 'workspace')).toBe(true)
})

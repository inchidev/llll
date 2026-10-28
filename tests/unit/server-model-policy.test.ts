import { expect, it } from 'vitest'
import { usesRetiredProductTerms } from '../../scripts/check-server-model.mjs'

it('allows coding checkout vocabulary only in the integrated factory sources', () => {
  const text = 'factory_workspaces workspace_id factory_workspace FactoryWorkspace workspaceId WorkspaceProvider WorkspaceJob WorkspaceReceipt workspaceRevision workspace workspace_ready'
  expect(usesRetiredProductTerms('shared/workspace-provider.ts', text)).toBe(false)
  expect(usesRetiredProductTerms('server/utils/factory-actions.ts', text)).toBe(false)
  expect(usesRetiredProductTerms('server/utils/authorization.ts', text)).toBe(true)
})
it('still rejects retired community models and new compound identifiers inside factory sources', () => {
  for (const text of ['workspace_members', 'WorkspaceAdminRole', 'installation', 'Instance', 'apps/instance']) {
    expect(usesRetiredProductTerms('server/utils/factory-actions.ts', text), text).toBe(true)
  }
})
it('keeps existing narrow GitHub provider exceptions without allowing installation products', () => {
  expect(usesRetiredProductTerms('server/utils/git-connections.ts', 'installationId sourceInstallationId workInstallationId /app/installations/ /installation/token /installation/repositories /installations/new')).toBe(false)
  expect(usesRetiredProductTerms('server/utils/git-connections.ts', 'installationMembers')).toBe(true)
})

it('allows the public workspace description without reviving workspace identity models', () => {
  expect(usesRetiredProductTerms('apps/site/app/pages/index.vue', 'One workspace for humans and agents. Isolated task workspaces.')).toBe(false)
  expect(usesRetiredProductTerms('apps/site/app/pages/index.vue', 'workspace_members')).toBe(true)
  expect(usesRetiredProductTerms('app/app.vue', 'One workspace for humans and agents.')).toBe(false)
  expect(usesRetiredProductTerms('shared/app-branding.ts', 'WorkspaceAdminRole')).toBe(true)
  expect(usesRetiredProductTerms('server/utils/authorization.ts', 'workspace')).toBe(true)
})

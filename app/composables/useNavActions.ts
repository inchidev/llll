/**
 * Sidebar actions that live in one component but are triggered from another —
 * the workspace dropdown and the `+` on each nav section header both open
 * modals that are mounted by NavShell or by the page currently on screen.
 */
export function useNavActions() {
  const createChannelOpen = useState('nav:create-channel', () => false)
  const createChannelCategoryId = useState<string | null>('nav:create-channel-category', () => null)
  const createCategoryOpen = useState('nav:create-category', () => false)
  const inviteOpen = useState('nav:invite', () => false)
  const workspaceSettingsOpen = useState('nav:workspace-settings', () => false)
  const workspaceSettingsSection = useState('nav:workspace-settings-section', () => 'overview')
  const createBoardOpen = useState('nav:create-board', () => false)
  const createDatabaseOpen = useState('nav:create-database', () => false)
  const createDocumentOpen = useState('nav:create-document', () => false)
  const createCanvasOpen = useState('nav:create-canvas', () => false)
  const createGadgetOpen = useState('nav:create-gadget', () => false)
  const composeOpen = useState('nav:compose', () => false)

  function openWorkspaceSettings(section: string) {
    workspaceSettingsSection.value = section
    workspaceSettingsOpen.value = true
  }

  function openCreateChannel(categoryId: string | null = null) {
    createChannelCategoryId.value = categoryId === 'uncategorized' ? null : categoryId
    createChannelOpen.value = true
  }

  return {
    createChannelOpen,
    createChannelCategoryId,
    createCategoryOpen,
    inviteOpen,
    workspaceSettingsOpen,
    workspaceSettingsSection,
    createBoardOpen,
    createDatabaseOpen,
    createDocumentOpen,
    createCanvasOpen,
    createGadgetOpen,
    composeOpen,
    openCreateChannel,
    openWorkspaceSettings,
  }
}

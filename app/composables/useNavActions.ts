/**
 * Sidebar actions that live in one component but are triggered from another —
 * the server dropdown and the `+` on each nav section header both open
 * modals that are mounted by NavShell or by the page currently on screen.
 */
export function useNavActions() {
  const createChannelOpen = useState('nav:create-channel', () => false)
  const createChannelCategoryId = useState<string | null>('nav:create-channel-category', () => null)
  const createCategoryOpen = useState('nav:create-category', () => false)
  const inviteOpen = useState('nav:invite', () => false)
  const serverSettingsOpen = useState('nav:server-settings', () => false)
  const serverSettingsSection = useState('nav:server-settings-section', () => 'overview')
  const createBoardOpen = useState('nav:create-board', () => false)
  const createDatabaseOpen = useState('nav:create-database', () => false)
  const createDocumentOpen = useState('nav:create-document', () => false)
  const documentCreating = useState('nav:document-creating', () => false)
  const createAgentOpen = useState('nav:create-agent', () => false)
  const createProjectOpen = useState('nav:create-project', () => false)
  const createCanvasOpen = useState('nav:create-canvas', () => false)
  const createGadgetOpen = useState('nav:create-gadget', () => false)
  const composeOpen = useState('nav:compose', () => false)

  function openServerSettings(section: string) {
    serverSettingsSection.value = section
    serverSettingsOpen.value = true
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
    serverSettingsOpen,
    serverSettingsSection,
    createBoardOpen,
    createProjectOpen,
    createDatabaseOpen,
    createDocumentOpen,
    documentCreating,
    createAgentOpen,
    createCanvasOpen,
    createGadgetOpen,
    composeOpen,
    openCreateChannel,
    openServerSettings,
  }
}

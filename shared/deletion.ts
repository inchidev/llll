export type ServerDeletionStatusDTO = {
  installationKind: 'guided' | 'manual'
}

export type ServerDeletionStartDTO = {
  uninstallUrl: string
  expiresAt: string
}

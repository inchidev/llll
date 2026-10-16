export const Permission = {
  manageWorkspace: 1 << 0,
  manageChannels: 1 << 1,
  manageRoles: 1 << 2,
  invite: 1 << 3,
  sendMessages: 1 << 4,
  attachFiles: 1 << 5,
  startLive: 1 << 6,
  kick: 1 << 7,
  manageTasks: 1 << 8,
  manageDatabases: 1 << 9,
  useGadgets: 1 << 10,
  manageGadgets: 1 << 11,
} as const

export type PermissionFlag = (typeof Permission)[keyof typeof Permission]

export const ALL_PERMISSIONS =
  Permission.manageWorkspace
  | Permission.manageChannels
  | Permission.manageRoles
  | Permission.invite
  | Permission.sendMessages
  | Permission.attachFiles
  | Permission.startLive
  | Permission.kick
  | Permission.manageTasks
  | Permission.manageDatabases
  | Permission.useGadgets
  | Permission.manageGadgets

export const MemberPermissions =
  Permission.sendMessages | Permission.attachFiles | Permission.startLive

export const PermissionGrants = [
  { key: 'manageWorkspace', flag: Permission.manageWorkspace, label: 'Manage workspace', description: 'Change workspace name and settings.' },
  { key: 'manageChannels', flag: Permission.manageChannels, label: 'Manage channels', description: 'Create, edit, and remove channels and categories.' },
  { key: 'manageRoles', flag: Permission.manageRoles, label: 'Manage roles', description: 'Create roles, change grants, and assign roles to members.' },
  { key: 'invite', flag: Permission.invite, label: 'Create invites', description: 'Invite new members to the workspace.' },
  { key: 'sendMessages', flag: Permission.sendMessages, label: 'Send messages', description: 'Post and reply in accessible channels.' },
  { key: 'attachFiles', flag: Permission.attachFiles, label: 'Attach files', description: 'Upload attachments to messages.' },
  { key: 'startLive', flag: Permission.startLive, label: 'Start live sessions', description: 'Start a live session or call in channels and direct messages they can access. Anyone with access can join.' },
  { key: 'kick', flag: Permission.kick, label: 'Remove members', description: 'Remove members from the workspace.' },
  { key: 'manageTasks', flag: Permission.manageTasks, label: 'Manage tasks', description: 'Create, edit, assign, archive, and remove task boards and tasks.' },
  { key: 'manageDatabases', flag: Permission.manageDatabases, label: 'Manage data', description: 'Create databases, documents, canvases, fields, and records.' },
  { key: 'useGadgets', flag: Permission.useGadgets, label: 'Use apps', description: 'Open published internal tools shared with this role.' },
  { key: 'manageGadgets', flag: Permission.manageGadgets, label: 'Manage apps', description: 'Create, configure, publish, and share internal tools.' },
] as const

export type PermissionGrantKey = (typeof PermissionGrants)[number]['key']

export function permissionBitmask(enabled: Iterable<PermissionGrantKey>): number {
  const keys = new Set(enabled)
  return PermissionGrants.reduce((bitmask, grant) => keys.has(grant.key) ? bitmask | grant.flag : bitmask, 0)
}

export function hasPermission(bitmask: number, flag: PermissionFlag): boolean {
  return (bitmask & flag) === flag
}

/**
 * Direct Message participants can always talk, but starting a Live room still
 * follows the member's role, so an owner can make a role that joins calls but
 * never starts them. A frozen Direct Message grants nothing.
 */
export function directMessagePermissions(rolePermissions: number, isOwner: boolean, frozen: boolean): number {
  if (frozen) return 0
  const canStartLive = isOwner || hasPermission(rolePermissions, Permission.startLive)
  return (MemberPermissions & ~Permission.startLive) | (canStartLive ? Permission.startLive : 0)
}

export function rolePermissions(name: string): number {
  if (name === 'owner' || name === 'admin') return ALL_PERMISSIONS
  return MemberPermissions
}

export const Permission = {
  proposeCode: 1 << 24,
  manageServer: 1 << 0,
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
  mcpConnect: 1 << 12,
  useAgents: 1 << 13,
  manageAgents: 1 << 14,
  approveAgentActions: 1 << 15,
  executeTasks: 1 << 16,
  useComputer: 1 << 17,
  manageSchedules: 1 << 18,
  readTasks: 1 << 19,
  writeTasks: 1 << 20,
  readData: 1 << 21,
  writeData: 1 << 22,
  browseWeb: 1 << 23,
} as const

export type PermissionFlag = (typeof Permission)[keyof typeof Permission]

export const ALL_PERMISSIONS =
  Permission.proposeCode | Permission.manageServer
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
  | Permission.mcpConnect
  | Permission.useAgents | Permission.manageAgents | Permission.approveAgentActions
  | Permission.executeTasks | Permission.useComputer | Permission.manageSchedules
  | Permission.readTasks | Permission.writeTasks | Permission.readData | Permission.writeData | Permission.browseWeb

export const MemberPermissions =
  Permission.sendMessages | Permission.attachFiles | Permission.startLive

export const PermissionGrants = [
  { key: 'proposeCode', flag: Permission.proposeCode, label: 'Propose code changes', description: 'Publish changes to an authorized working fork and open draft pull requests. Does not permit merges or production releases.' },
  { key: 'manageServer', flag: Permission.manageServer, label: 'Manage server', description: 'Change server name and settings.' },
  { key: 'manageChannels', flag: Permission.manageChannels, label: 'Manage channels', description: 'Create, edit, and remove channels and categories.' },
  { key: 'manageRoles', flag: Permission.manageRoles, label: 'Manage roles', description: 'Create roles, change grants, and assign roles to members.' },
  { key: 'invite', flag: Permission.invite, label: 'Create invites', description: 'Invite new members to the server.' },
  { key: 'sendMessages', flag: Permission.sendMessages, label: 'Send messages', description: 'Post and reply in accessible channels.' },
  { key: 'attachFiles', flag: Permission.attachFiles, label: 'Attach files', description: 'Upload attachments to messages.' },
  { key: 'startLive', flag: Permission.startLive, label: 'Start live sessions', description: 'Start a live session or call in channels and direct messages they can access. Anyone with access can join.' },
  { key: 'kick', flag: Permission.kick, label: 'Remove members', description: 'Remove members from the server.' },
  { key: 'manageTasks', flag: Permission.manageTasks, label: 'Manage tasks', description: 'Create, edit, assign, archive, and remove task boards and tasks.' },
  { key: 'manageDatabases', flag: Permission.manageDatabases, label: 'Manage data', description: 'Create databases, documents, canvases, fields, and records.' },
  { key: 'useGadgets', flag: Permission.useGadgets, label: 'Use apps', description: 'Open published internal tools shared with this role.' },
  { key: 'manageGadgets', flag: Permission.manageGadgets, label: 'Manage apps', description: 'Create, configure, publish, and share internal tools.' },
  { key: 'useAgents', flag: Permission.useAgents, label: 'Use agents', description: 'Discover agents, talk to them, and give bounded instructions.' },
  { key: 'manageAgents', flag: Permission.manageAgents, label: 'Manage agents', description: 'Create agents and change their profiles, models, and runtime settings.' },
  { key: 'approveAgentActions', flag: Permission.approveAgentActions, label: 'Approve agent actions', description: 'Review and approve pending actions in conversations you can access.' },
  { key: 'executeTasks', flag: Permission.executeTasks, label: 'Execute assigned tasks', description: 'Allow an agent to execute work within an authorized task mandate.' },
  { key: 'useComputer', flag: Permission.useComputer, label: 'Use a computer', description: 'Allow isolated filesystem and shell tools in assigned working directories.' },
  { key: 'manageSchedules', flag: Permission.manageSchedules, label: 'Manage schedules', description: 'Create and cancel reminders and recurring authorized work.' },
  { key: 'readTasks', flag: Permission.readTasks, label: 'Read tasks', description: 'Read authorized task boards and tasks.' },
  { key: 'writeTasks', flag: Permission.writeTasks, label: 'Create and update tasks', description: 'Create and update authorized tasks without managing or deleting boards.' },
  { key: 'readData', flag: Permission.readData, label: 'Read data', description: 'Read authorized tables, records, and documents.' },
  { key: 'writeData', flag: Permission.writeData, label: 'Write data', description: 'Create and edit records and documents without deleting resources or changing table structure.' },
  { key: 'browseWeb', flag: Permission.browseWeb, label: 'Research the web', description: 'Search and read public web sources through the Server’s configured providers.' },
  { key: 'mcp.connect', flag: Permission.mcpConnect, label: 'Connect MCP clients', description: 'Allow external MCP clients to act as this member within their role and approved scopes.' },
] as const

export const AgentPermissions = Permission.useAgents | Permission.manageAgents | Permission.approveAgentActions

export type PermissionGrantKey = (typeof PermissionGrants)[number]['key']

export function permissionBitmask(enabled: Iterable<PermissionGrantKey>): number {
  const keys = new Set(enabled)
  return PermissionGrants.reduce((bitmask, grant) => keys.has(grant.key) ? bitmask | grant.flag : bitmask, 0)
}

export function hasPermission(bitmask: number, flag: PermissionFlag): boolean {
  if ((bitmask & flag) === flag) return true
  if (flag === Permission.readTasks || flag === Permission.writeTasks) return (bitmask & Permission.manageTasks) !== 0
  if (flag === Permission.readData || flag === Permission.writeData) return (bitmask & Permission.manageDatabases) !== 0
  return false
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
  if (name === 'owner') return ALL_PERMISSIONS
  if (name === 'admin') return ALL_PERMISSIONS & ~(Permission.mcpConnect | Permission.executeTasks | Permission.useComputer | Permission.manageSchedules | Permission.proposeCode)
  return MemberPermissions
}

import { hasPermission, Permission, type PermissionFlag } from './permissions'

export const CHANNEL_PERMISSION_MASK =
  Permission.sendMessages
  | Permission.attachFiles
  | Permission.startLive

export const ChannelPermissionGrants = [
  { key: 'sendMessages', flag: Permission.sendMessages, label: 'Send messages' },
  { key: 'attachFiles', flag: Permission.attachFiles, label: 'Attach files' },
  { key: 'startLive', flag: Permission.startLive, label: 'Start live sessions' },
] as const

export type ChannelPermissionGrantKey = (typeof ChannelPermissionGrants)[number]['key']
export type ChannelPermissionMode = 'inherit' | 'allow' | 'deny'

export type ChannelPermissionMasks = {
  allow: number
  deny: number
}

export function resolveChannelPermissions(base: number, override?: Partial<ChannelPermissionMasks> | null): number {
  if (!override) return base
  const allow = override.allow ?? 0
  const deny = override.deny ?? 0
  return (base & ~deny) | allow
}

export function isChannelPermissionMask(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && (value & ~CHANNEL_PERMISSION_MASK) === 0
}

export function channelPermissionMode(allow: number, deny: number, flag: PermissionFlag): ChannelPermissionMode {
  if (hasPermission(allow, flag)) return 'allow'
  if (hasPermission(deny, flag)) return 'deny'
  return 'inherit'
}

export function channelPermissionMasks(modes: Partial<Record<ChannelPermissionGrantKey, ChannelPermissionMode>>): ChannelPermissionMasks {
  let allow = 0
  let deny = 0
  for (const grant of ChannelPermissionGrants) {
    const mode = modes[grant.key] ?? 'inherit'
    if (mode === 'allow') allow |= grant.flag
    if (mode === 'deny') deny |= grant.flag
  }
  return { allow, deny }
}

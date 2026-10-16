import { describe, expect, it } from 'vitest'
import {
  CHANNEL_PERMISSION_MASK,
  channelPermissionMasks,
  channelPermissionMode,
  isChannelPermissionMask,
  resolveChannelPermissions,
} from '../../shared/channel-permissions'
import { hasPermission, Permission } from '../../shared/permissions'

describe('channel permission overrides', () => {
  it('applies an allow and deny after the role permissions', () => {
    const result = resolveChannelPermissions(
      Permission.sendMessages | Permission.attachFiles | Permission.invite,
      { allow: Permission.startLive, deny: Permission.attachFiles },
    )

    expect(hasPermission(result, Permission.sendMessages)).toBe(true)
    expect(hasPermission(result, Permission.attachFiles)).toBe(false)
    expect(hasPermission(result, Permission.startLive)).toBe(true)
    expect(hasPermission(result, Permission.invite)).toBe(true)
  })

  it('accepts only the three channel-scoped permission bits', () => {
    expect(isChannelPermissionMask(0)).toBe(true)
    expect(isChannelPermissionMask(CHANNEL_PERMISSION_MASK)).toBe(true)
    expect(isChannelPermissionMask(Permission.manageChannels)).toBe(false)
    expect(isChannelPermissionMask(-1)).toBe(false)
    expect(isChannelPermissionMask(1.5)).toBe(false)
  })

  it('round-trips inherit, allow, and deny modes', () => {
    const masks = channelPermissionMasks({
      sendMessages: 'deny',
      attachFiles: 'inherit',
      startLive: 'allow',
    })

    expect(channelPermissionMode(masks.allow, masks.deny, Permission.sendMessages)).toBe('deny')
    expect(channelPermissionMode(masks.allow, masks.deny, Permission.attachFiles)).toBe('inherit')
    expect(channelPermissionMode(masks.allow, masks.deny, Permission.startLive)).toBe('allow')
    expect(masks.allow & masks.deny).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, hasPermission, MemberPermissions, Permission, permissionBitmask, rolePermissions } from '../../shared/permissions'

describe('permissions', () => {
  it('owner has every flag', () => {
    expect(hasPermission(ALL_PERMISSIONS, Permission.kick)).toBe(true)
    expect(hasPermission(ALL_PERMISSIONS, Permission.manageWorkspace)).toBe(true)
    expect(rolePermissions('owner')).toBe(ALL_PERMISSIONS)
  })

  it('keeps the default member role limited to chat', () => {
    expect(hasPermission(MemberPermissions, Permission.sendMessages)).toBe(true)
    expect(hasPermission(MemberPermissions, Permission.attachFiles)).toBe(true)
    expect(hasPermission(MemberPermissions, Permission.startLive)).toBe(true)
    expect(hasPermission(MemberPermissions, Permission.manageTasks)).toBe(false)
    expect(hasPermission(MemberPermissions, Permission.manageDatabases)).toBe(false)
    expect(hasPermission(MemberPermissions, Permission.useGadgets)).toBe(false)
    expect(hasPermission(MemberPermissions, Permission.manageGadgets)).toBe(false)
    expect(hasPermission(MemberPermissions, Permission.manageWorkspace)).toBe(false)
    expect(hasPermission(MemberPermissions, Permission.kick)).toBe(false)
    expect(rolePermissions('member')).toBe(MemberPermissions)
  })

  it('includes databases in owner and admin authority', () => {
    expect(hasPermission(ALL_PERMISSIONS, Permission.manageDatabases)).toBe(true)
    expect(hasPermission(ALL_PERMISSIONS, Permission.useGadgets)).toBe(true)
    expect(hasPermission(ALL_PERMISSIONS, Permission.manageGadgets)).toBe(true)
    expect(rolePermissions('admin')).toBe(ALL_PERMISSIONS)
  })

  it('builds a custom role bitmask from grants', () => {
    const permissions = permissionBitmask(['sendMessages', 'invite'])
    expect(hasPermission(permissions, Permission.sendMessages)).toBe(true)
    expect(hasPermission(permissions, Permission.invite)).toBe(true)
    expect(hasPermission(permissions, Permission.manageRoles)).toBe(false)
  })
})

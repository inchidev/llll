import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import migration from '../../drizzle/server-migrations/0003_mcp_connect_grant.sql?raw'
import { ALL_PERMISSIONS, hasPermission, MemberPermissions, Permission, permissionBitmask, rolePermissions } from '../../shared/permissions'

describe('permissions', () => {
  it('owner has every flag', () => {
    expect(hasPermission(ALL_PERMISSIONS, Permission.kick)).toBe(true)
    expect(hasPermission(ALL_PERMISSIONS, Permission.manageServer)).toBe(true)
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
    expect(hasPermission(MemberPermissions, Permission.manageServer)).toBe(false)
    expect(hasPermission(MemberPermissions, Permission.kick)).toBe(false)
    expect(rolePermissions('member')).toBe(MemberPermissions)
  })

  it('includes databases in owner and admin authority', () => {
    expect(hasPermission(ALL_PERMISSIONS, Permission.manageDatabases)).toBe(true)
    expect(hasPermission(ALL_PERMISSIONS, Permission.useGadgets)).toBe(true)
    expect(hasPermission(ALL_PERMISSIONS, Permission.manageGadgets)).toBe(true)
    expect(rolePermissions('admin')).toBe(ALL_PERMISSIONS & ~Permission.mcpConnect)
  })

  it('requires an explicit mcp.connect grant for every role except owner', () => {
    for (const name of ['admin', 'member', 'agent', 'custom']) {
      expect(hasPermission(rolePermissions(name), Permission.mcpConnect)).toBe(false)
    }
    expect(hasPermission(rolePermissions('owner'), Permission.mcpConnect)).toBe(true)
    expect(permissionBitmask(['mcp.connect'])).toBe(Permission.mcpConnect)
  })

  it('opts only the owner role into MCP when upgrading existing roles', () => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec("CREATE TABLE roles (key TEXT, permissions_bitmask INTEGER); INSERT INTO roles VALUES ('owner',4095),('admin',4095),('member',112),('agent',768)")
      database.exec(migration)
      expect(database.prepare('SELECT key,permissions_bitmask FROM roles').all()).toEqual([
        { key: 'owner', permissions_bitmask: ALL_PERMISSIONS },
        { key: 'admin', permissions_bitmask: ALL_PERMISSIONS & ~Permission.mcpConnect },
        { key: 'member', permissions_bitmask: MemberPermissions },
        { key: 'agent', permissions_bitmask: Permission.manageTasks | Permission.manageDatabases },
      ])
    }
    finally { database.close() }
  })

  it('builds a custom role bitmask from grants', () => {
    const permissions = permissionBitmask(['sendMessages', 'invite'])
    expect(hasPermission(permissions, Permission.sendMessages)).toBe(true)
    expect(hasPermission(permissions, Permission.invite)).toBe(true)
    expect(hasPermission(permissions, Permission.manageRoles)).toBe(false)
  })
})

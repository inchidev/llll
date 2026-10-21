import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import agentMigration from '../../drizzle/server-migrations/0004_agent_permissions.sql?raw'
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
    expect(rolePermissions('admin')).toBe(ALL_PERMISSIONS & ~(Permission.mcpConnect | Permission.executeTasks | Permission.useComputer | Permission.manageSchedules))
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
        { key: 'owner', permissions_bitmask: 8191 },
        { key: 'admin', permissions_bitmask: 4095 },
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


describe('agent permission upgrade', () => {
  it('preserves old tools and agent administration without enabling computers or autonomous runs', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec("CREATE TABLE roles (key TEXT, permissions_bitmask INTEGER); INSERT INTO roles VALUES ('admin',4095), ('member',112), ('reader',0);")
      db.exec(agentMigration)
      const admin = db.prepare("SELECT permissions_bitmask AS permissions FROM roles WHERE key='admin'").get()!.permissions as number
      for (const permission of [Permission.useAgents, Permission.manageAgents, Permission.approveAgentActions, Permission.readTasks, Permission.writeTasks, Permission.readData, Permission.writeData]) {
        expect(hasPermission(admin, permission)).toBe(true)
      }
      for (const permission of [Permission.executeTasks, Permission.useComputer, Permission.manageSchedules]) expect(hasPermission(admin, permission)).toBe(false)
      expect(db.prepare("SELECT permissions_bitmask AS permissions FROM roles WHERE key='member'").get()!.permissions).toBe(112)
    } finally { db.close() }
  })
})

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { d1ExecSql, INIT_SQL } from '../../server/utils/db'

describe('ensureMigrated', () => {
  it('does not apply the bundled schema when the runtime is celld', async () => {
    vi.resetModules()
    const { ensureMigrated } = await import('../../server/utils/db')
    const exec = vi.fn(async () => {})
    const db = {
      exec,
      prepare: () => ({
        first: async () => {
          throw new Error('missing table')
        },
      }),
    }

    await expect(ensureMigrated(db as never, { LLLL_RUNTIME: 'celld' })).rejects.toThrow('missing table')
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('fresh D1 schema', () => {
  it('keeps trigger bodies together as one D1 exec statement', () => {
    const sql = d1ExecSql(`
      CREATE TRIGGER example AFTER UPDATE ON messages BEGIN
        DELETE FROM derived WHERE id = OLD.id;
        INSERT INTO derived (id) VALUES (NEW.id);
      END;
      --> statement-breakpoint
      SELECT 1;
    `)
    const lines = sql.split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('DELETE FROM derived WHERE id = OLD.id; INSERT INTO derived')
    expect(lines[0]).toMatch(/END;$/u)
  })

  it('boots with constrained channel role overrides', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)

    sqlite.exec("INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('role', 'custom:role', 'Role', 0)")
    sqlite.exec("INSERT INTO channels (id, name, type, visibility) VALUES ('channel', 'Channel', 'text', 'server')")
    sqlite.exec("INSERT INTO channel_role_overrides (channel_id, role_id, allow_mask, deny_mask) VALUES ('channel', 'role', 16, 32)")

    expect(() => sqlite.exec(
      "INSERT INTO channel_role_overrides (channel_id, role_id, allow_mask, deny_mask) VALUES ('channel', 'role-2', 2, 0)",
    )).toThrow()
    expect(() => sqlite.exec(
      "INSERT INTO channel_role_overrides (channel_id, role_id, allow_mask, deny_mask) VALUES ('channel-2', 'role', 16, 16)",
    )).toThrow()
  })

})

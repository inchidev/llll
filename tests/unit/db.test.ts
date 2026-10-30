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

  it('boots with constrained channel grants and denies', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)

    sqlite.exec("INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('role', 'custom:role', 'Role', 0)")
    sqlite.exec("INSERT INTO channels (id, name, type, visibility) VALUES ('channel', 'Channel', 'text', 'server')")
    sqlite.exec("INSERT INTO grants (id, role_id, permissions, channel_id, created_at) VALUES ('g', 'role', 16, 'channel', 'now')")
    sqlite.exec("INSERT INTO channel_role_denies (channel_id, role_id, deny_mask, created_at) VALUES ('channel', 'role', 32, 'now')")
    expect(sqlite.prepare('SELECT allow_mask, deny_mask FROM channel_role_overrides').all()).toEqual([{ allow_mask: 16, deny_mask: 32 }])

    // Only send, attach and Live; only Roles; never a Policy on a channel.
    expect(() => sqlite.exec("INSERT INTO grants (id, role_id, permissions, channel_id, created_at) VALUES ('g2', 'role', 2, 'channel', 'now')")).toThrow()
    expect(() => sqlite.exec("INSERT INTO channel_role_denies (channel_id, role_id, deny_mask, created_at) VALUES ('channel', 'role', 2, 'now')")).toThrow()
    expect(() => sqlite.exec("INSERT INTO channel_role_overrides (channel_id, role_id, allow_mask, deny_mask) VALUES ('channel', 'role', 16, 0)")).toThrow()
  })

})

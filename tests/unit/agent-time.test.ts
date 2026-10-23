import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { agentTimeContext } from '../../server/utils/agent-time'
import type { L4Env } from '../../workers/env'
it('uses an explicit Server timezone across a date boundary, falling back to UTC for invalid settings', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT); INSERT INTO server_settings VALUES('server.timezone','Asia/Ho_Chi_Minh','')")
    const env = { DB: d1(db) } as L4Env
    const now = new Date('2026-10-23T23:30:00Z')
    expect(await agentTimeContext(env, now)).toMatchObject({ utc: now.toISOString(), timezone: 'Asia/Ho_Chi_Minh', localTime: expect.stringContaining('October 24') })
    db.exec("UPDATE server_settings SET value='invalid timezone'")
    expect(await agentTimeContext(env, now)).toMatchObject({ timezone: 'UTC', localTime: expect.stringContaining('October 23') })
  } finally { db.close() }
})

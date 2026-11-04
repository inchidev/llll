import type { DatabaseFieldDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { allocateDatabaseSlot, databaseFieldConfig } from './database-data'
import { fail } from './cf'

/** Claim one physical slot atomically, retrying if another field just took it. */
export async function insertDatabaseField(env: L4Env, field: DatabaseFieldDTO, actorId: string): Promise<void> {
  let inserted = false
  for (let attempt = 0; attempt < 8; attempt++) {
    const slot = await allocateDatabaseSlot(env, field.databaseId, field.type)
    const saved = await env.DB.prepare(
      `INSERT INTO database_fields
       (id, database_id, name, type, slot, config_json, position, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM database_fields WHERE database_id = ? AND slot = ?)
       RETURNING id`,
    ).bind(field.id, field.databaseId, field.name, field.type, slot, databaseFieldConfig(field), field.position, actorId, field.createdAt, field.updatedAt, field.databaseId, slot).first()
    if (saved) { inserted = true; break }
  }
  if (!inserted) fail(409, 'field_conflict', 'Fields changed concurrently. Retry adding the field.')
}

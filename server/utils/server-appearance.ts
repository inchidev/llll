import { getServerId } from '../../shared/server-id'
import { appearanceFromSettings } from '../../shared/server-appearance'

export async function publicServerAppearance(db: D1Database, origin: string, fallbackName: string) {
  const id = await getServerId(db)
  const row = await db.prepare('SELECT id, name, icon_r2_key AS iconR2Key, updated_at AS updatedAt FROM server WHERE id = ?').bind(id)
    .first<{ id: string; name: string; iconR2Key: string | null; updatedAt: string }>()
  return { ...(row ? appearanceFromSettings(origin, row) : { id, name: fallbackName, iconUrl: null }), ready: Boolean(row) }
}

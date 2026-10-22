import { getServerId } from '../../shared/server-id'
import { readServerSetting } from '../../shared/server-settings'
import { appearanceFromSettings } from '../../shared/server-appearance'

export async function publicServerAppearance(db: D1Database, origin: string, fallbackName: string) {
  const id = await getServerId(db)
  const row = await db.prepare('SELECT id, name, icon_r2_key AS iconR2Key, updated_at AS updatedAt FROM server WHERE id = ?').bind(id)
    .first<{ id: string; name: string; iconR2Key: string | null; updatedAt: string }>()
  if (row) return { ...appearanceFromSettings(origin, row), ready: true }
  // Before owner setup the installer-provisioned initial name wins.
  let initialName: string | null = null
  try { initialName = await readServerSetting(db, 'initial_name') } catch { /* Fresh database. */ }
  return { id, name: initialName?.trim() || fallbackName, iconUrl: null, ready: false }
}

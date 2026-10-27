import { createError } from './errors.js'

type Query = (sql: string, params: (string | number)[]) => Promise<{ value: string }[]>
const key = 'factory.provisioning'
const unused = "NOT EXISTS(SELECT 1 FROM compute_nodes WHERE json_extract(capabilities_json,'$.provider')='cloudflare-containers') AND NOT EXISTS(SELECT 1 FROM factory_workspaces)"

/** This marker fences Server activation. A failed/expired repair stays closed to
 * activation; another installer may take it over only while no authority exists. */
export async function beginUnusedFactoryRepair(query: Query) {
  const token = crypto.randomUUID()
  const value = () => JSON.stringify({ token, expiresAt: Date.now() + 15 * 60000, failed: false })
  const rows = await query(`INSERT INTO server_settings(key,value,updated_at) SELECT ?,?,? WHERE ${unused}
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE json_valid(server_settings.value) AND (json_extract(server_settings.value,'$.expiresAt')<=? OR json_extract(server_settings.value,'$.failed')=1)
    RETURNING value`, [key, value(), new Date().toISOString(), Date.now()])
  if (!rows.length) throw createError({ statusCode: 409, statusMessage: 'Preserve/export existing Factory Task source and its connected Node before replacing the pinned image or limits. Another provisioning request may still be running.' })
  return {
    async check() {
      const renewed = await query(`UPDATE server_settings SET value=?,updated_at=? WHERE key=? AND json_extract(value,'$.token')=? AND ${unused} RETURNING value`, [value(), new Date().toISOString(), key, token])
      if (!renewed.length) throw createError({ statusCode: 409, statusMessage: 'Factory repair authority changed; inspect the existing provider before retrying' })
    },
    async complete() {
      const removed = await query("DELETE FROM server_settings WHERE key=? AND json_extract(value,'$.token')=? RETURNING value", [key, token])
      if (!removed.length) throw createError({ statusCode: 409, statusMessage: 'Factory repair was superseded; inspect provisioning before activation' })
    },
    async failed() {
      await query("UPDATE server_settings SET value=json_set(value,'$.failed',1) WHERE key=? AND json_extract(value,'$.token')=? RETURNING value", [key, token])
    },
  }
}

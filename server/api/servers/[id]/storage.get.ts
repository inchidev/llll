import { BASIC_FILE_LIMIT, BASIC_STORAGE_LIMIT } from '../../../../shared/file-storage'
import { updateOwner, serverDeployment } from '../../../utils/server-updates'

export default defineEventHandler(async event => {
  const { env } = await updateOwner(event)
  const used = await env.DB.prepare('SELECT COALESCE(SUM(size),0) as bytes,COUNT(*) as files,SUM(CASE WHEN copied=1 THEN 1 ELSE 0 END) as copied FROM file_objects').first<{ bytes: number; files: number; copied: number }>()
  const saved = await env.DB.prepare("SELECT key,value FROM server_settings WHERE key IN ('storage.backend','storage.migration')").all<{ key: string; value: string }>()
  const settings = Object.fromEntries(saved.results.map(row => [row.key, row.value]))
  const deployment = await serverDeployment(env, getRequestURL(event).origin)
  const url = deployment ? new URL('/create', deployment.site) : null
  if (url && deployment) url.search = new URLSearchParams({ tab: 'cloudflare', storage: '1', server: deployment.origin, account: deployment.accountId, worker: deployment.workerName }).toString()
  return { backend: !env.FILES || settings['storage.backend'] === 'kv' ? 'kv' : 'r2', r2Available: Boolean(env.FILES), migrating: settings['storage.migration'] === 'r2', usedBytes: used?.bytes ?? 0, files: used?.files ?? 0, copied: used?.copied ?? 0, limitBytes: BASIC_STORAGE_LIMIT, maxFileBytes: BASIC_FILE_LIMIT, connectUrl: url?.toString() ?? null }
})

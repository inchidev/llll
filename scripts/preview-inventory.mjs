
/**
 * Read-only inventory of leftover isolated Server Preview resources. Prints a
 * concrete deletion proposal; it never issues a write or delete request.
 * Approval on the printed list is required before any administrative cleanup.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/preview-inventory.mjs
 */
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
if (!account || !token) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (read-only scope).')
  process.exit(1)
}
async function api(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  })
  const data = await response.json()
  if (!response.ok || !data.success) {
    throw new Error(`Cloudflare GET ${path}: ${response.status} ${JSON.stringify(data.errors)}`)
  }
  return data.result
}
async function paginate(path, pick) {
  const out = []
  for (let page = 1; page <= 50; page++) {
    const separator = path.includes('?') ? '&' : '?'
    const result = await api(`${path}${separator}per_page=50&page=${page}`)
    const items = pick(result)
    out.push(...items)
    const info = result.result_info
    if (!items.length || (info && page >= info.total_pages) || !info) break
  }
  return out
}
const workers = (await paginate('/accounts/' + account + '/workers/scripts', result => Array.isArray(result) ? result : result?.scripts || []))
  .filter(worker => /^llll-server-pr-\d+/.test(worker.id || ''))
const databases = (await paginate('/accounts/' + account + '/d1/database', result => result || []))
  .filter(database => /^llll-server-pr-\d+/.test(database.name || ''))
const storage = await api('/accounts/' + account + '/r2/buckets?per_page=100')
const buckets = (storage.buckets || []).filter(bucket => /^llll-server-pr-\d+/.test(bucket.name || ''))
const namespaces = (await paginate('/accounts/' + account + '/storage/kv/namespaces', result => result || []))
  .filter(namespace => /^llll-server-pr-\d+/.test(namespace.title || ''))
const domains = []
for (const worker of workers) {
  for (const domain of (await paginate('/accounts/' + account + '/workers/domains', result => result || []))) {
    if (domain.service === worker.id) domains.push({ hostname: domain.hostname, service: domain.service, id: domain.id })
  }
}
const inventory = { workers: workers.map(w => ({ id: w.id, modifiedOn: w.modified_on })), databases, buckets, namespaces, domains }
console.log(JSON.stringify(inventory, null, 2))
const deletions = {
  workers: workers.map(w => w.id),
  domains: domains.map(d => `${d.hostname} (${d.id})`),
  databases: databases.map(d => `${d.name} (${d.uuid || d.id})`),
  buckets: buckets.map(b => b.name),
  namespaces: namespaces.map(n => `${n.title} (${n.id})`),
}
console.error('\nProposed deletion list (requires John\'s explicit approval; this script deletes nothing):')
console.error(JSON.stringify(deletions, null, 2))

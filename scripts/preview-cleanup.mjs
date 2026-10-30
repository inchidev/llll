/**
 * Removes what closed PRs left behind: their native Worker Previews (with their Durable
 * Objects) and their per-PR D1 databases. It runs from the main Preview Build after every
 * merge. Anything belonging to `main` or an open PR stays, and so does every resource that
 * does not follow the Preview naming exactly: production, installed Servers, other projects,
 * shared staging buckets and backups.
 */
const previewDatabase = /^llll(?:-server)?-pr-(\d+)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/

/** Open same-repository PRs, from GitHub's public API. Any doubt means no cleanup. */
export async function openPullRequests(repository = 'inchidev/llll', transport = fetch) {
  const open = []
  for (let page = 1; page <= 10; page++) {
    const response = await transport(`https://api.github.com/repos/${repository}/pulls?state=open&per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'llll-preview-cleanup' },
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`GitHub open PR list failed (${response.status})`)
    const items = await response.json()
    if (!Array.isArray(items)) throw new Error('GitHub returned an invalid PR list')
    for (const item of items) {
      if (!Number.isSafeInteger(item?.number) || typeof item?.head?.ref !== 'string') throw new Error('GitHub returned an invalid PR')
      open.push({ number: item.number, branch: item.head.ref })
    }
    if (items.length < 100) return open
  }
  throw new Error('Too many open PRs to decide safely')
}

/** Everything closed PRs left: what to delete, decided from names alone. */
export function closedPreviewResources({ open, previews, databases }) {
  const branches = new Set(['main', ...open.map(pr => pr.branch)])
  const numbers = new Set(open.map(pr => pr.number))
  return {
    previews: previews.filter(preview => typeof preview.name === 'string' && !branches.has(preview.name)),
    databases: databases.filter(database => {
      const match = previewDatabase.exec(database.name || '')
      return Boolean(match) && !numbers.has(Number(match[1]))
    }),
  }
}

async function listAll(api, path) {
  const items = []
  for (let page = 1; page <= 100; page++) {
    const result = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    if (!Array.isArray(result)) throw new Error(`Cloudflare returned an invalid list for ${path}`)
    items.push(...result)
    if (result.length < 100) return items
  }
  throw new Error(`Cloudflare pagination limit reached for ${path}`)
}

/**
 * `api(path, method)` is the account-scoped Cloudflare API that returns `result`.
 * Returns what it deleted; a failed deletion is reported and the rest continue.
 */
export async function cleanupClosedPreviews({ api, open, workers = ['llll-server', 'llll'], log = console.log }) {
  const deleted = { previews: [], databases: [], failed: [] }
  for (const worker of workers) {
    const previews = await listAll(api, `/workers/workers/${worker}/previews`)
    for (const preview of closedPreviewResources({ open, previews, databases: [] }).previews) {
      try { await api(`/workers/workers/${worker}/previews/${preview.id}`, 'DELETE'); deleted.previews.push(`${worker}:${preview.name}`) }
      catch (error) { deleted.failed.push(`${worker}:${preview.name}: ${error.message}`) }
    }
  }
  const databases = await listAll(api, '/d1/database')
  for (const database of closedPreviewResources({ open, previews: [], databases }).databases) {
    try { await api(`/d1/database/${database.uuid}`, 'DELETE'); deleted.databases.push(database.name) }
    catch (error) { deleted.failed.push(`${database.name}: ${error.message}`) }
  }
  log(`Preview cleanup: ${deleted.previews.length} Previews and ${deleted.databases.length} databases of closed PRs removed${deleted.failed.length ? `; failed: ${deleted.failed.join('; ')}` : ''}`)
  return deleted
}

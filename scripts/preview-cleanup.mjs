/**
 * Removes what closed PRs left behind: their native Worker Previews (with their Durable
 * Objects) and their per-PR D1 databases. It runs from the main Preview Build after every
 * merge. Anything belonging to `main`, a live branch or an open PR stays, and so does every resource that
 * does not follow the Preview naming exactly: production, installed Servers, other projects,
 * shared staging buckets and backups.
 */
const previewDatabase = /^llll(?:-server)?-pr-(\d+)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/

/**
 * What is still alive, from `git ls-remote <repo> 'refs/heads/*' 'refs/pull/*'`. Git refs avoid
 * the REST API quota Builds share. A branch is alive while it exists; a PR is open while GitHub
 * keeps its merge ref or its head is still a live branch. Doubt keeps a resource.
 */
export function liveRefs(lsRemote) {
  const heads = new Map(), pulls = new Map()
  for (const line of lsRemote.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (!sha || !ref) continue
    if (ref.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), sha)
    const pull = /^refs\/pull\/(\d+)\/(head|merge)$/.exec(ref)
    if (pull) pulls.set(Number(pull[1]), { ...pulls.get(Number(pull[1])), [pull[2]]: sha })
  }
  if (!heads.has('main')) throw new Error('Git refs are incomplete: main is missing')
  const liveShas = new Set(heads.values())
  const numbers = new Set([...pulls].filter(([, refs]) => refs.merge || (refs.head && liveShas.has(refs.head))).map(([number]) => number))
  return { branches: new Set(heads.keys()), numbers }
}

/** Everything closed PRs left: what to delete, decided from names alone. */
export function closedPreviewResources({ live, previews, databases }) {
  const { branches, numbers } = live
  return {
    previews: previews.filter(preview => typeof preview.name === 'string' && preview.name !== 'main' && !branches.has(preview.name)),
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
export async function cleanupClosedPreviews({ api, live, workers = ['llll-server', 'llll'], log = console.log }) {
  const deleted = { previews: [], databases: [], failed: [] }
  for (const worker of workers) {
    const previews = await listAll(api, `/workers/workers/${worker}/previews`)
    for (const preview of closedPreviewResources({ live, previews, databases: [] }).previews) {
      try { await api(`/workers/workers/${worker}/previews/${preview.id}`, 'DELETE'); deleted.previews.push(`${worker}:${preview.name}`) }
      catch (error) { deleted.failed.push(`${worker}:${preview.name}: ${error.message}`) }
    }
  }
  const databases = await listAll(api, '/d1/database')
  for (const database of closedPreviewResources({ live, previews: [], databases }).databases) {
    try { await api(`/d1/database/${database.uuid}`, 'DELETE'); deleted.databases.push(database.name) }
    catch (error) { deleted.failed.push(`${database.name}: ${error.message}`) }
  }
  log(`Preview cleanup: ${deleted.previews.length} Previews and ${deleted.databases.length} databases of closed PRs removed${deleted.failed.length ? `; failed: ${deleted.failed.join('; ')}` : ''}`)
  return deleted
}

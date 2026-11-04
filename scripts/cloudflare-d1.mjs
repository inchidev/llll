/** Find an exact D1 name without creating or changing any resource. */
export async function findD1Database(api, name) {
  const pageSize = 100
  for (let page = 1; page <= 1000; page++) {
    const query = new URLSearchParams({ name, per_page: '100', page: String(page) })
    const data = await api('/d1/database?' + query)
    if (!Array.isArray(data.result)) throw new Error('Cloudflare returned an invalid D1 list')
    const found = data.result.find(item => item.name === name)
    if (found) return found
    const info = data.result_info ?? {}
    // D1 currently reports total_count rather than total_pages. Some callers
    // retain only result; a full page must still continue in that case.
    if (Number.isSafeInteger(info.total_count) && info.total_count >= 0) {
      const size = Number.isSafeInteger(info.per_page) && info.per_page > 0 ? info.per_page : pageSize
      if (page * size >= info.total_count) return undefined
    } else if (Number.isSafeInteger(info.total_pages) && info.total_pages >= 0) {
      if (page >= info.total_pages) return undefined
    } else if (data.result.length < pageSize) return undefined
  }
  throw new Error('Cloudflare D1 pagination limit reached; resource discovery is incomplete')
}

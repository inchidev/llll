import type { DataReferenceType, DataSearchHit } from './data-search'
import { boardPath, databasePath } from './paths'

export type LinkPreview = {
  url: string
  title: string
  description?: string
  kind: DataReferenceType | 'website' | 'conversation' | 'message'
  image?: string
  status?: string
}

export function dataHitPath(hit: DataSearchHit): string {
  if (hit.type === 'task') return `${boardPath(hit.resourceId)}&task=${encodeURIComponent(hit.id)}`
  if (hit.type === 'database') return databasePath(hit.id)
  return `/items/${encodeURIComponent(hit.id)}`
}

export function internalLinkTarget(url: URL): { type: DataReferenceType; id: string } | null {
  const item = url.pathname.match(/^\/items\/([^/]+)\/?$/)
  if (item) return { type: 'item', id: decodeURIComponent(item[1]!) }
  if (['/projects/board', '/tasks'].includes(url.pathname) && url.searchParams.get('task')) return { type: 'task', id: url.searchParams.get('task')! }
  if (url.pathname === '/databases' && url.searchParams.get('record')) return { type: 'item', id: url.searchParams.get('record')! }
  if (url.pathname === '/databases' && url.searchParams.get('database')) return { type: 'database', id: url.searchParams.get('database')! }
  return null
}

/** Links from our escaped Markdown output only. Code and unrevealed spoilers never trigger a fetch. */
export function previewLinks(html: string): string[] {
  const links = new Set<string>()
  const stack: boolean[] = []
  for (const token of html.matchAll(/<(\/?)([a-z0-9]+)\b([^>]*)>/g)) {
    const [, closing, tag, attributes = ''] = token
    if (closing) { stack.pop(); continue }
    const hidden = Boolean(stack.at(-1)) || tag === 'pre' || tag === 'code' || /class="spoiler"/.test(attributes)
    if (tag === 'a' && !hidden) {
      const url = attributes.match(/\bhref="([^"]+)"/)?.[1]
        ?.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
      if (url && (/^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url))) links.add(url)
      if (links.size === 3) break
    }
    if (!['br', 'hr', 'img'].includes(tag!)) stack.push(hidden)
  }
  return [...links]
}

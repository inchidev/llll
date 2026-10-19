/** Route paths keep a trailing slash when a page is reached directly by its directory
 * URL (e.g. /create/ served by static hosting); compare on the normalized form. */
export function normalizeRoutePath(path: string): string {
  const clean = path.replace(/\/+$/, '')
  return clean || '/'
}

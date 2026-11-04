import { z } from 'zod'

export type ServerAppearance = { id: string; name: string; iconUrl?: string | null; updatedAt?: string; version?: string }
export const publicIconPath = '/.well-known/llll/icon'

/** Only the Server's public icon endpoint may be persisted or loaded by Shell. */
export function serverIconUrl(value: unknown, origin: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value, origin)
    if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== publicIconPath) return null
    if ([...url.searchParams.keys()].some(key => key !== 'v') || url.searchParams.getAll('v').length > 1) return null
    return url.toString()
  } catch { return null }
}

const appearanceSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(100),
  iconUrl: z.unknown().optional(), updatedAt: z.string().datetime().optional(), version: z.string().max(50).optional(),
})
export function serverAppearance(value: unknown, origin: string): ServerAppearance {
  const data = appearanceSchema.parse(value)
  return {
    id: data.id, name: data.name,
    ...(data.iconUrl !== undefined ? { iconUrl: serverIconUrl(data.iconUrl, origin) } : {}),
    ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
    ...(data.version ? { version: data.version } : {}),
  }
}

export function appearanceFromSettings(origin: string, row: { id: string; name: string; iconR2Key: string | null; updatedAt: string }): ServerAppearance {
  return serverAppearance({ id: row.id, name: row.name, updatedAt: row.updatedAt, iconUrl: row.iconR2Key ? `${origin}${publicIconPath}?v=${encodeURIComponent(row.updatedAt)}` : null }, origin)
}

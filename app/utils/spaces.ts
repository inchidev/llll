import type { SpaceDTO } from '~~/shared/spaces'

/** One Space means nothing to choose: a small team and a contractor in one Space see no switcher. */
export function showSpaceSwitcher(spaces: readonly SpaceDTO[]) {
  return spaces.length >= 2
}

/**
 * The Space to show. Only a joined Space can be active: the Server ignores the header for a
 * Space the viewer is not in, and that includes an Owner who manages it without having joined.
 */
export function resolveActiveSpace(spaces: readonly SpaceDTO[], stored: string | null | undefined) {
  const joined = spaces.filter(space => space.role)
  return joined.find(space => space.id === stored) ?? joined.find(space => space.isDefault) ?? joined[0] ?? null
}

export type Breadcrumb = { label: string; to?: string }

/** The trail under a Space, which is named only for someone who has more than one. */
export function breadcrumbTrail(spaceName: string | null | undefined, items: readonly Breadcrumb[]): Breadcrumb[] {
  return spaceName ? [{ label: spaceName }, ...items] : [...items]
}

/** Up to two letters for the switcher's tile. */
export function spaceInitials(name: string | null | undefined) {
  const words = (name ?? '').trim().split(/\s+/u).filter(Boolean)
  return words.slice(0, 2).map(word => Array.from(word)[0]!.toLocaleUpperCase()).join('') || '?'
}

/** The Spaces to point at: never the one already on screen, whose Inbox is right there. */
export function spacesWaiting(spaceIds: readonly string[] | undefined, activeSpaceId: string | null | undefined) {
  return new Set((spaceIds ?? []).filter(id => id !== activeSpaceId))
}

/** The header belongs on this Server's API only, never on another origin that has an `/api/` path. */
export function spaceHeaderApplies(request: string, base: string | undefined, pageOrigin: string, activeOrigin: string | null | undefined) {
  try {
    const url = new URL(request, base || pageOrigin)
    return url.pathname.startsWith('/api/') && (url.origin === pageOrigin || url.origin === activeOrigin)
  }
  catch { return false }
}

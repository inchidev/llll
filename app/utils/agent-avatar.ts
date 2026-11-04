import { isStoredAvatarKey } from '~~/shared/avatar'
import type { UserKind } from '~~/shared/types'

// L4 agent avatars: a rounded block with a face, drawn from the agent id so it
// never changes. Background and feature colours are stops from one ramp each.
const palettes = [
  ['#1D9E75', '#04342C'], ['#7F77DD', '#26215C'], ['#EF9F27', '#412402'], ['#D85A30', '#4A1B0C'],
  ['#378ADD', '#042C53'], ['#D4537E', '#4B1528'], ['#97C459', '#173404'], ['#D3D1C7', '#2C2C2A'],
] as const

function hash(id: string, salt = 0) {
  let value = 2166136261 ^ salt
  for (let index = 0; index < id.length; index += 1) {
    value ^= id.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

/** The face: eyes always, a mouth on some, each varied by a separate slice of the hash. */
function face(id: string, ink: string, bg: string) {
  const eyes = hash(id, 1) % 4, mouth = hash(id, 2) % 3, gap = 11 + (hash(id, 3) % 3), y = 19 + (hash(id, 4) % 3)
  const [left, right] = [22 - gap / 2 - 0.5, 22 + gap / 2 + 0.5]
  const eye = (x: number) => [
    `<circle cx="${x}" cy="${y}" r="3.5" fill="${ink}"/>`,
    `<rect x="${x - 3.5}" y="${y - 1.5}" width="7" height="3" rx="1.5" fill="${ink}"/>`,
    `<circle cx="${x}" cy="${y}" r="4" fill="${ink}"/><circle cx="${x + 0.8}" cy="${y + 0.8}" r="1.8" fill="${bg}"/>`,
    `<circle cx="${x}" cy="${y}" r="2.5" fill="${ink}"/>`,
  ][eyes]!
  const mouths = ['', `<rect x="18" y="${y + 9}" width="8" height="2.5" rx="1.25" fill="${ink}"/>`, `<path d="M18 ${y + 8} Q22 ${y + 11} 26 ${y + 8}" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>`]
  return eye(left) + eye(right) + mouths[mouth]
}

export function agentAvatarSvg(id: string): string {
  const [bg, ink] = palettes[hash(id) % palettes.length]!
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><rect width="44" height="44" rx="10" fill="${bg}"/>${face(id, ink, bg)}</svg>`
}

/** A same-origin data URI, which the image policy allows, so no request or asset is needed. */
export function agentAvatarSrc(id: string): string {
  return `data:image/svg+xml,${encodeURIComponent(agentAvatarSvg(id))}`
}

/**
 * Same-origin path for a participant's picture: an uploaded avatar when one exists, a generated
 * image for agents, and nothing for humans without an upload so the caller falls back to initials.
 * API paths are versioned by object key so caches never serve a replaced picture.
 */
export function userAvatarSrc(user: { id: string, kind: UserKind, avatarR2Key?: string | null }): string | undefined {
  if (isStoredAvatarKey(user.avatarR2Key)) {
    const path = user.kind === 'agent'
      ? `/api/agents/${user.id}/avatar`
      : `/api/users/${user.id}/avatar`
    return `${path}?v=${encodeURIComponent(user.avatarR2Key)}`
  }
  return user.kind === 'agent' ? agentAvatarSrc(user.id) : undefined
}

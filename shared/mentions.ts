const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const MENTION_RE = new RegExp(`<@(${UUID})>`, 'gi')
const ROLE_MENTION_RE = new RegExp(`<@&(${UUID})>`, 'gi')

type Mentionable = { id: string; displayName: string; nickname?: string | null }
/** A Role the author may mention, under the name people see. */
export type MentionRole = { id: string; name: string }
type RoleLike = { id: string; key: string; name: string; mentionable?: boolean }

function tokenIds(content: string, pattern: RegExp): string[] {
  const ids = new Set<string>()
  for (const match of content.matchAll(pattern)) {
    if (match[1]) ids.add(match[1].toLowerCase())
  }
  return [...ids]
}

export function extractMentionIds(content: string): string[] {
  return tokenIds(content, MENTION_RE)
}

/** Role mention tokens, `<@&roleId>`. */
export function extractRoleMentionIds(content: string): string[] {
  return tokenIds(content, ROLE_MENTION_RE)
}

/** The built-in Roles are stored lowercase but shown capitalized. */
export function roleDisplayName(role: Pick<RoleLike, 'key' | 'name'>): string {
  if (role.key === 'owner') return 'Owner'
  if (role.key === 'admin') return 'Admin'
  if (role.key === 'member') return 'Member'
  return role.name
}

/**
 * Roles held by these Members that the viewer may mention: mentionable ones, or every
 * Role for the Owner and Members with Manage channels. The server applies the same rule.
 */
export function mentionRoles(members: Array<{ role: RoleLike }>, canMentionAny: boolean): MentionRole[] {
  const roles = new Map<string, MentionRole>()
  for (const { role } of members) {
    if (canMentionAny || role.mentionable) roles.set(role.id, { id: role.id, name: roleDisplayName(role) })
  }
  return [...roles.values()]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Turns `@Name` into a mention token. Names may contain spaces, as the composer's
 * autocomplete inserts them; the longest matching name wins, so `@Ada Lovelace`
 * never stops at a member called `Ada`. A name two members share stays plain text:
 * guessing could address an Agent that copied a person's name. Roles become
 * `<@&id>` under the same rule, so a name a Role shares with a Member or another Role stays text too.
 */
export function applyMentionTokens(content: string, members: Mentionable[], roles: MentionRole[] = []): string {
  const byName = new Map<string, string | null>()
  const add = (names: Array<string | null | undefined>, token: string) => {
    for (const name of new Set(names.map(value => value?.trim().toLowerCase()))) {
      if (!name || name.length > 64) continue
      byName.set(name, byName.has(name) && byName.get(name) !== token ? null : token)
    }
  }
  for (const member of members) add([member.displayName, member.nickname], `<@${member.id}>`)
  for (const role of roles) add([role.name], `<@&${role.id}>`)
  for (const [name, token] of byName) if (!token) byName.delete(name)
  if (!byName.size) return content
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
  const pattern = new RegExp(`(^|\\s)@(${names.join('|')})(?=$|[\\s.,!?;:)\\]'"])`, 'gi')
  return content.replace(pattern, (full, prefix: string, name: string) => {
    const token = byName.get(name.toLowerCase())
    return token ? `${prefix}${token}` : full
  })
}

/**
 * The reverse of applyMentionTokens, for putting a sent message back into an editor.
 * Member names are keyed by ID and Role names by `&` and the ID.
 */
export function humanizeMentions(content: string, names: Record<string, string>): string {
  const named = (full: string, key: string) => {
    const name = names[key.toLowerCase()] ?? names[key]
    return name ? `@${name}` : full
  }
  return content
    .replace(ROLE_MENTION_RE, (full, id: string) => named(full, `&${id}`))
    .replace(MENTION_RE, (full, id: string) => named(full, id))
}

/** The `@query` being typed at the caret, if any, for mention autocomplete. */
export function activeTrigger(text: string, caret: number, trigger: '@' | ':'): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf(trigger)
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null
  const query = before.slice(at + 1)
  if (trigger === ':') {
    // Emoji shortcodes are single words and need two characters before suggesting.
    if (!/^[\w+-]{2,32}$/.test(query)) return null
  }
  else if (query.length > 32 || /\n/.test(query) || /\s{2}/.test(query) || /^\s/.test(query)) return null
  return { start: at, query }
}

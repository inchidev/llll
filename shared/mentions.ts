const MENTION_RE = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi

type Mentionable = { id: string; displayName: string; nickname?: string | null }

export function extractMentionIds(content: string): string[] {
  const ids = new Set<string>()
  for (const match of content.matchAll(MENTION_RE)) {
    if (match[1]) ids.add(match[1].toLowerCase())
  }
  return [...ids]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Turns `@Name` into a mention token. Names may contain spaces, as the composer's
 * autocomplete inserts them; the longest matching name wins, so `@Ada Lovelace`
 * never stops at a member called `Ada`.
 */
export function applyMentionTokens(content: string, members: Mentionable[]): string {
  const byName = new Map<string, string>()
  for (const member of members) {
    for (const name of [member.displayName, member.nickname]) {
      const key = name?.trim().toLowerCase()
      if (key && key.length <= 64 && !byName.has(key)) byName.set(key, member.id)
    }
  }
  if (!byName.size) return content
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
  const pattern = new RegExp(`(^|\\s)@(${names.join('|')})(?=$|[\\s.,!?;:)\\]'"])`, 'gi')
  return content.replace(pattern, (full, prefix: string, name: string) => {
    const id = byName.get(name.toLowerCase())
    return id ? `${prefix}<@${id}>` : full
  })
}

/** The reverse of applyMentionTokens, for putting a sent message back into an editor. */
export function humanizeMentions(content: string, names: Record<string, string>): string {
  return content.replace(MENTION_RE, (full, id: string) => {
    const name = names[id.toLowerCase()] ?? names[id]
    return name ? `@${name}` : full
  })
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

import { extractMentionIds, extractRoleMentionIds, humanizeMentions, roleDisplayName } from '../../shared/mentions'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'

/** Letters that read as Latin ones. Both cases, because case folding merges some that look different. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  А: 'a', а: 'a', В: 'b', в: 'b', Е: 'e', е: 'e', Ё: 'e', ё: 'e', Г: 'r', г: 'r', Ґ: 'r', ґ: 'r', Ѕ: 's', ѕ: 's', І: 'i', і: 'i', Ї: 'i', ї: 'i', Ј: 'j', ј: 'j',
  К: 'k', к: 'k', М: 'm', м: 'm', Н: 'h', н: 'h', О: 'o', о: 'o', П: 'n', п: 'n', Р: 'p', р: 'p', С: 'c', с: 'c', Т: 't', т: 't', У: 'y', у: 'y', Х: 'x', х: 'x',
  Ь: 'b', ь: 'b', Һ: 'h', һ: 'h', Ԁ: 'd', ԁ: 'd', Ԛ: 'q', ԛ: 'q', Ԝ: 'w', ԝ: 'w', Ӏ: 'i', ӏ: 'i', З: '3', з: '3',
  // Greek
  Α: 'a', α: 'a', Β: 'b', β: 'b', γ: 'y', Ε: 'e', ε: 'e', Ζ: 'z', ζ: 'z', Η: 'h', η: 'n', Ι: 'i', ι: 'i', Κ: 'k', κ: 'k', Μ: 'm', μ: 'u', Ν: 'n', ν: 'v',
  Ο: 'o', ο: 'o', Ρ: 'p', ρ: 'p', Τ: 't', τ: 't', Υ: 'y', υ: 'u', Χ: 'x', χ: 'x', ω: 'w',
  // Latin
  ı: 'i', İ: 'i', ſ: 's',
}
const lookalike = (text: string) => text.replace(/./gsu, char => CONFUSABLES[char] ?? char)

/**
 * What a name looks like, for comparing names: two names with one key would read as one person.
 * Compatibility forms, case and invisible characters do not count (zero-width and bidi controls
 * included), nor do letters from another script or digits that look the same. It catches lookalikes within Latin, Cyrillic and Greek, not every script,
 * and it is a comparison key: never stored and never shown.
 */
export function memberNameKey(name: string): string {
  const visible = name.normalize('NFKC').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
  // JavaScript has no case fold. Up then down gets the expansions (ß to ss) and merges final sigma.
  const folded = lookalike(lookalike(visible).toUpperCase().toLowerCase())
  return folded.replace(/\s+/gu, ' ').trim()
    .replace(/[l1|]/gu, 'i').replace(/0/gu, 'o').replace(/rn/gu, 'm').replace(/vv/gu, 'w')
}

async function nameTaken(env: L4Env, key: string, exceptId: string, agentsOnly: boolean) {
  const rows = (await env.DB.prepare(`SELECT display_name AS displayName, nickname FROM users WHERE status<>'removed' AND id<>? ${agentsOnly ? "AND kind='agent'" : ''}`)
    .bind(exceptId).all<{ displayName: string; nickname: string | null }>()).results ?? []
  return rows.some(row => memberNameKey(row.displayName) === key || (row.nickname !== null && memberNameKey(row.nickname) === key))
}

function visibleKey(displayName: string) {
  const key = memberNameKey(displayName)
  if (!key) fail(400, 'bad_request', 'Use a name with visible characters')
  return key
}

/** Agents cannot take a name another Member already uses: in chat and mentions it would read as that person. */
export async function assertAgentNameAvailable(env: L4Env, displayName: string, exceptId?: string) {
  if (await nameTaken(env, visibleKey(displayName), exceptId ?? '', false)) fail(409, 'name_taken', 'Another member already uses this name. Choose a distinct name for the agent.')
}

/**
 * The reverse rule: a person cannot take an active Agent's name, or their messages
 * would read as the Agent's. People may still share names with each other.
 */
export async function assertHumanNameAvailable(env: L4Env, displayName: string, userId: string) {
  if (await nameTaken(env, visibleKey(displayName), userId, true)) fail(409, 'name_taken', 'An agent already uses this name. Choose a different display name.')
}

/** Replaces `<@id>` and `<@&roleId>` tokens with `@Name`, as people see them in chat. Unknown IDs stay as tokens. */
export async function readableMentions(env: L4Env, texts: string[]): Promise<string[]> {
  const ids = [...new Set(texts.flatMap(extractMentionIds))]
  const roleIds = [...new Set(texts.flatMap(extractRoleMentionIds))]
  const names: Record<string, string> = {}
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const rows = await env.DB.prepare(`SELECT id, COALESCE(nickname, display_name) AS name FROM users WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ id: string; name: string }>()
    for (const row of rows.results ?? []) names[row.id.toLowerCase()] = row.name
  }
  if (roleIds.length) {
    const rows = await env.DB.prepare('SELECT id, key, name FROM roles WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(roleIds)).all<{ id: string; key: string; name: string }>()
    for (const row of rows.results ?? []) names[`&${row.id.toLowerCase()}`] = roleDisplayName(row)
  }
  return texts.map(text => humanizeMentions(text, names))
}

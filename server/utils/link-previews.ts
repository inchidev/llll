import sanitizeHtml from 'sanitize-html'
import { dmTitle } from '../../shared/dm'
import { dataHitPath, internalLinkTarget, type LinkPreview } from '../../shared/link-previews'
import type { L4Env } from '../../workers/env'
import { cloudflareNetwork } from '../../workers/env'
import { boundedBytes, fetchPreview } from './preview-fetch'
import { visibleDataReference } from './data-references'
import { getTask } from './task-service'
import { requireChannelAccessForMember, type ServerMembership } from './channel-access'

/** Extract plain metadata, never third-party markup or active embeds. */
export function pageMetadata(html: string): { title: string; description: string; image?: string } {
  const metadata = new Map<string, string>()
  let title = ''
  sanitizeHtml(html, {
    allowedTags: ['title'], allowedAttributes: {},
    onOpenTag(name, attributes) {
      if (name !== 'meta') return
      const key = (attributes.property || attributes.name || '').toLowerCase()
      if (!metadata.has(key) && attributes.content) metadata.set(key, attributes.content)
    },
    textFilter(text, tag) { if (tag === 'title') title += text; return '' },
  })
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }
  const plain = (text: string, limit: number) => sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(amp|lt|gt|quot|#39);/g, (_match, entity: string) => entities[entity]!)
    .replace(/\s+/g, ' ').trim().slice(0, limit)
  return {
    title: plain(metadata.get('og:title') || metadata.get('twitter:title') || title, 240),
    description: plain(metadata.get('og:description') || metadata.get('description') || metadata.get('twitter:description') || '', 500),
    image: metadata.get('og:image') || metadata.get('twitter:image'),
  }
}

function rasterType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const head = new TextDecoder().decode(bytes.subarray(0, 12))
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif'
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') return 'image/webp'
  return null
}

/** Public metadata may be cached; private titles are always resolved with this reader's current authority. */
export async function linkPreview(env: L4Env, member: ServerMembership, raw: string, origin: string): Promise<LinkPreview | null> {
  const auth = member.authorization
  const url = new URL(raw, origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  const ownOrigins = new Set([new URL(origin).origin, ...(env.PUBLIC_ORIGIN ? [new URL(env.PUBLIC_ORIGIN).origin] : [])])
  if (ownOrigins.has(url.origin)) {
    const conversation = url.pathname.match(/^\/(?:channels|agents)\/([^/]+)(?:\/threads\/([^/]+))?\/?$/)
    if (conversation) {
      try {
        const access = await requireChannelAccessForMember(env, member, decodeURIComponent(conversation[2] || conversation[1]!))
        if (conversation[2] && access.channel.parentId !== decodeURIComponent(conversation[1]!)) return null
        const title = access.channel.type === 'dm' ? dmTitle(access.channel.name, access.participants, member.user.id) : access.channel.name
        const messageId = url.searchParams.get('message')
        if (!messageId) return { kind: 'conversation', url: url.pathname, title }
        const message = await env.DB.prepare('SELECT m.content,u.display_name AS author FROM messages m JOIN users u ON u.id=m.author_id WHERE m.id=? AND m.channel_id=? AND m.deleted_at IS NULL')
          .bind(messageId, access.channel.id).first<{ content: string; author: string }>()
        return message ? { kind: 'message', url: `${url.pathname}?message=${encodeURIComponent(messageId)}`, title: `${message.author} · ${title}`, description: message.content.replace(/\|\|[\s\S]*?\|\|/g, '[spoiler]').slice(0, 500) } : null
      } catch (error) {
        if (error && typeof error === 'object' && 'statusCode' in error && [403, 404].includes(Number(error.statusCode))) return null
        throw error
      }
    }
    const target = internalLinkTarget(url)
    if (!target) return null
    const hit = await visibleDataReference(env, auth, target.type, target.id)
    if (!hit) return null
    if (hit.type === 'task') {
      const task = await getTask(env, auth, hit.id)
      if (!task) return null
      return { kind: 'task', url: dataHitPath(hit), title: `#${task.number} ${task.title}`, status: task.status }
    }
    return { kind: hit.type, url: dataHitPath(hit), title: hit.title || 'Untitled' }
  }
  url.hash = ''
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.href))
  const key = `link-preview:v1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
  const cached = await env.TICKETS?.get<{ preview: LinkPreview | null }>(key, 'json')
  if (cached) return cached.preview
  const serverHosts = [...ownOrigins].map(value => new URL(value).hostname)
  let preview: LinkPreview | null = null
  const signal = AbortSignal.timeout(8000)
  try {
    const response = await fetchPreview(url.href, serverHosts, 1_048_576, signal, cloudflareNetwork(env))
    if (!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel()
      throw new Error('No HTML preview')
    }
    const metadata = pageMetadata(new TextDecoder().decode(await boundedBytes(response, 1_048_576)))
    if (metadata.title) {
      preview = { kind: 'website', url: url.href, title: metadata.title, description: metadata.description }
      if (metadata.image) {
        try {
          const imageResponse = await fetchPreview(new URL(metadata.image, response.headers.get('x-l4-preview-url') || url).href, serverHosts, 300_000, signal, cloudflareNetwork(env))
          if (!imageResponse.ok) { await imageResponse.body?.cancel(); throw new Error('No image') }
          const bytes = await boundedBytes(imageResponse, 300_000)
          const type = rasterType(bytes)
          if (type) {
            let binary = ''
            for (const byte of bytes) binary += String.fromCharCode(byte)
            preview.image = `data:${type};base64,${btoa(binary)}`
          }
        } catch { /* The text card is useful when its image cannot be loaded. */ }
      }
    }
  } catch { /* Unavailable websites leave the original clickable link intact. */ }
  await env.TICKETS?.put(key, JSON.stringify({ preview }), { expirationTtl: preview ? 3600 : 300 })
  return preview
}

const DANGEROUS_PROTO = /^(javascript|data|vbscript):/i
/** `- item`, `* item`, or `1. item` / `1) item`; group 1 is the number for ordered items. */
const LIST_ITEM = /^\s{0,3}(?:[-*]|(\d{1,9})[.)])\s+(.*)$/
const HEADING = /^(#{1,3})\s+(.+)$/
const SUBTEXT = /^-#\s+(.+)$/
/** A bare URL in escaped text; stops before escaped angle brackets and quotes. */
const BARE_URL = /\bhttps?:\/\/(?:(?!&lt;|&gt;|&quot;)\S)+/g
/** Placeholders are wrapped in NUL, which escaped user text never contains. */
const SLOT = /\0(\d+)\0/g

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function unescapeHtml(input: string): string {
  return input
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

function safeHref(raw: string): string | null {
  const href = raw.trim()
  if (DANGEROUS_PROTO.test(href)) return null
  if (href.startsWith('/') || href.startsWith('#') || href.startsWith('https://') || href.startsWith('http://') || href.startsWith('mailto:')) {
    return escapeHtml(href)
  }
  return null
}

/** Trailing sentence punctuation, and a closing parenthesis the URL never opened, belong to the text. */
function splitUrlTail(url: string): [string, string] {
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1]!
    if ('.,;:!?\'"'.includes(ch)) end -= 1
    else if (ch === ')' && !url.slice(0, end).includes('(')) end -= 1
    else break
  }
  return [url.slice(0, end), url.slice(end)]
}

function link(href: string, label: string): string {
  return `<a href="${href}" rel="noopener noreferrer" target="_blank">${label}</a>`
}

/**
 * Formats one line of already-escaped text. Code spans, links, and mentions are
 * lifted into placeholders first, so emphasis never reaches inside them.
 */
function inline(src: string): string {
  const slots: string[] = []
  const hold = (html: string) => `\0${slots.push(html) - 1}\0`
  let out = escapeHtml(src)

  out = out.replace(/`([^`]+)`/g, (_m, code: string) => hold(`<code>${code}</code>`))
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label: string, url: string) => {
    const href = safeHref(unescapeHtml(url))
    return href ? hold(link(href, label)) : label
  })
  out = out.replace(BARE_URL, (match) => {
    const [url, tail] = splitUrlTail(match)
    const href = safeHref(unescapeHtml(url))
    return href ? hold(link(href, href)) + tail : match
  })
  out = out.replace(
    /&lt;@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})&gt;/gi,
    (_m, id: string) => hold(`<span class="mention" data-user-id="${id}">@${id}</span>`),
  )

  out = out.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" role="button" tabindex="0" aria-label="Spoiler">$1</span>')
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_]+)__/g, '<u>$1</u>')
  out = out.replace(/(^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\*)/g, '$1<em>$2</em>')
  out = out.replace(/(^|[^\w])_([^_]+)_(?!\w)/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>')

  return out.replace(SLOT, (_m, index: string) => slots[Number(index)] ?? '')
}

export function renderMarkdown(src: string, names?: Record<string, string>): string {
  const fences: string[] = []
  // `>>> ` quotes everything after it, like Discord.
  const multiQuote = src.match(/^([\s\S]*?)(?:^|\n)>>> ([\s\S]*)$/)
  const body = multiQuote
    ? `${multiQuote[1]}\n${(multiQuote[2] ?? '').split('\n').map(line => `> ${line}`).join('\n')}`
    : src
  const withFences = body.replace(/```(?:([\w+#.-]{1,20})\n)?([\s\S]*?)```/g, (_m, lang: string | undefined, code: string) => {
    const i = fences.length
    const language = lang ? ` class="language-${escapeHtml(lang.toLowerCase())}"` : ''
    fences.push(`<pre><code${language}>${escapeHtml(code.replace(/^\n/, '').replace(/\n$/, ''))}</code></pre>`)
    return `\n%%FENCE${i}%%\n`
  })

  const lines = withFences.split('\n')
  const html: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = line.match(/^%%FENCE(\d+)%%$/)
    if (fence) {
      html.push(fences[Number(fence[1])] ?? '')
      i += 1
      continue
    }
    if (line.startsWith('> ') || line === '>') {
      const quote: string[] = []
      while (i < lines.length && ((lines[i] ?? '').startsWith('> ') || lines[i] === '>')) {
        quote.push((lines[i] ?? '').slice(2))
        i += 1
      }
      html.push(`<blockquote>${quote.map((q) => inline(q)).join('<br>')}</blockquote>`)
      continue
    }
    const heading = line.match(HEADING)
    if (heading) {
      const level = heading[1]!.length
      html.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`)
      i += 1
      continue
    }
    const subtext = line.match(SUBTEXT)
    if (subtext) {
      html.push(`<p class="subtext">${inline(subtext[1] ?? '')}</p>`)
      i += 1
      continue
    }
    const list = line.match(LIST_ITEM)
    if (list) {
      const ordered = Boolean(list[1])
      const start = ordered ? Number(list[1]) : 1
      const items: string[] = []
      while (i < lines.length) {
        const item = (lines[i] ?? '').match(LIST_ITEM)
        if (!item || Boolean(item[1]) !== ordered) break
        items.push(`<li>${inline(item[2] ?? '')}</li>`)
        i += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      html.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${tag}>`)
      continue
    }
    if (line.trim() === '') {
      i += 1
      continue
    }
    html.push(`<p>${inline(line)}</p>`)
    i += 1
  }

  let out = html.join('')
  if (names) {
    out = out.replace(/<span class="mention" data-user-id="([^"]+)">@[^<]+<\/span>/g, (full, id: string) => {
      const name = names[id.toLowerCase()] ?? names[id]
      if (!name) return full
      return `<span class="mention" data-user-id="${id}">@${escapeHtml(name)}</span>`
    })
  }
  return out
}

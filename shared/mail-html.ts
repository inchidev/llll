import { compile } from 'html-to-text'
import { escapeHtml, renderInlineMarkdown } from './markdown'

/** Formatting an outbound email may carry. Everything else is removed, keeping its text. */
const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'h1', 'h2', 'h3'])
const TOKENS = /<!--[\s\S]*?(?:-->|$)|<(script|style|template)\b[\s\S]*?(?:<\/\1\s*>|$)|<(\/?)([a-z][a-z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</giu
const LIST_ITEM = /^\s{0,3}(?:[-*+]|(\d{1,9})[.)])\s+(.*)$/u
const MAX_QUOTE_DEPTH = 8

const toText = compile({
  wordwrap: false,
  limits: { maxInputLength: 400_000, maxDepth: 100, maxChildNodes: 10_000 },
  selectors: [
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ...['h1', 'h2', 'h3'].map(selector => ({ selector, options: { uppercase: false } })),
  ],
})

function decodeAttribute(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/giu, (_match, decimal: string, hex: string, named: string) => {
    if (named) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[named.toLowerCase()]!
    const code = decimal ? Number(decimal) : Number.parseInt(hex, 16)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}

function attributes(name: string, source: string): string {
  const value = (attribute: string) => {
    const match = new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'iu').exec(source)
    return match ? decodeAttribute(match[1] ?? match[2] ?? match[3] ?? '') : null
  }
  if (name === 'a') {
    // Browsers ignore whitespace and control characters inside a URL scheme.
    const href = value('href')?.replace(/[\p{Cc}\s]+/gu, '')
    return href && /^(?:https?:\/\/|mailto:)/iu.test(href) ? ` href="${escapeHtml(href)}" rel="noopener noreferrer"` : ''
  }
  if (name === 'ol') {
    const start = value('start')
    return start && /^\d{1,9}$/u.test(start) && start !== '1' ? ` start="${start}"` : ''
  }
  return ''
}

/**
 * Allowlist sanitizer for outbound HTML: allowed tags keep only safe attributes
 * (http, https and mailto links; list start), scripts, styles and comments are
 * dropped with their contents, every other tag is dropped and its text kept,
 * and stray angle brackets are escaped. The result is always balanced.
 */
export function sanitizeMailHtml(html: string): string {
  const out: string[] = []
  // Open elements; a link without a safe address is open but not written.
  const open: Array<{ name: string; written: boolean }> = []
  const close = () => { const element = open.pop()!; if (element.written) out.push(`</${element.name}>`) }
  for (const [whole, dropped, closing, rawName, attrs, text] of html.matchAll(TOKENS)) {
    if (text !== undefined) { out.push(text.replace(/>/gu, '&gt;')); continue }
    if (whole === '<') { out.push('&lt;'); continue }
    if (dropped !== undefined || !rawName) continue
    const name = rawName.toLowerCase()
    if (!ALLOWED.has(name)) continue
    if (name === 'br') { out.push('<br>'); continue }
    if (closing) {
      const index = open.findLastIndex(element => element.name === name)
      if (index >= 0) while (open.length > index) close()
      continue
    }
    const safe = attributes(name, attrs ?? '')
    const written = name !== 'a' || Boolean(safe)
    if (written) out.push(`<${name}${safe}>`)
    open.push({ name, written })
  }
  while (open.length) close()
  return out.join('')
}

function blocks(lines: string[], depth: number): string[] {
  const html: string[] = []
  const startsBlock = (line: string) => /^(?:```|#{1,3}\s|>)/u.test(line) || LIST_ITEM.test(line)
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    if (!line.trim()) { index += 1; continue }
    if (line.startsWith('```')) {
      const code: string[] = []
      for (index += 1; index < lines.length && !lines[index]!.startsWith('```'); index += 1) code.push(lines[index]!)
      index += 1
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line)
    if (heading) {
      html.push(`<h${heading[1]!.length}>${renderInlineMarkdown(heading[2]!)}</h${heading[1]!.length}>`)
      index += 1
      continue
    }
    if (line.startsWith('>') && depth < MAX_QUOTE_DEPTH) {
      const quoted: string[] = []
      for (; index < lines.length && lines[index]!.startsWith('>'); index += 1) quoted.push(lines[index]!.replace(/^> ?/u, ''))
      html.push(`<blockquote>${blocks(quoted, depth + 1).join('')}</blockquote>`)
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      const ordered = Boolean(item[1])
      const start = ordered ? Number(item[1]) : 1
      const items: string[] = []
      for (let next = LIST_ITEM.exec(lines[index] ?? ''); next && Boolean(next[1]) === ordered; next = LIST_ITEM.exec(lines[index] ?? '')) {
        items.push(`<li>${renderInlineMarkdown(next[2]!)}</li>`)
        index += 1
      }
      html.push(`<${ordered ? 'ol' : 'ul'}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    const paragraph: string[] = []
    for (; index < lines.length && lines[index]!.trim() && (!paragraph.length || !startsBlock(lines[index]!)); index += 1) paragraph.push(lines[index]!)
    html.push(`<p>${paragraph.map(text => renderInlineMarkdown(text)).join('<br>')}</p>`)
  }
  return html
}

/**
 * The HTML part of an email written with formatting: paragraphs, line breaks,
 * **bold**, _italic_, links, lists, quotes, headings and code. Everything the
 * writer typed is escaped first, and the result passes the allowlist above.
 */
export function mailMarkdownHtml(markdown: string): string {
  const body = sanitizeMailHtml(blocks(markdown.replace(/\r\n?/gu, '\n').split('\n'), 0).join('\n'))
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`
}

/** The text/plain alternative for formatted mail, and how the conversation shows it. */
export function mailHtmlText(html: string): string {
  return toText(html).replace(/^\n+|\s+$/gu, '')
}

export function mailMarkdownText(markdown: string): string {
  return mailHtmlText(mailMarkdownHtml(markdown))
}

// Docs, blog and changelog content for llll.gg. Pure functions shared by the
// prerendered pages (through ./content-files.mjs at build time) and the build
// script that writes the agent and crawler files (Markdown copies, llms.txt,
// sitemap, feeds). Nothing here runs in the browser or in the Worker.
import { Marked } from 'marked'

import { SITE, DOC_SECTIONS } from './site.mjs'

export { SITE, DOC_SECTIONS }

const CALLOUTS = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' }

/** Minimal frontmatter: `key: value` lines between `---` fences; quotes are optional. */
export function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { data: {}, body: source }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!pair) continue
    let value = pair[2].trim()
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    data[pair[1]] = /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value
  }
  return { data, body: source.slice(match[0].length) }
}

/** Text outside `<…>` tags; an unclosed `<` drops the rest. */
function stripTags(html) {
  let text = ''
  let inTag = false
  for (const character of String(html)) {
    if (character === '<') inTag = true
    else if (character === '>' && inTag) inTag = false
    else if (!inTag) text += character
  }
  return text
}

export function slugify(text) {
  return stripTags(text).toLowerCase().replace(/&[a-z]+;|&#\d+;/g, '').replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-')
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Plain text of a short Markdown fragment, for descriptions and feeds. */
export function plainText(markdown) {
  return String(markdown).replace(/```[\s\S]*?```/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim()
}

function firstParagraph(markdown) {
  const paragraph = markdown.split(/\r?\n\s*\r?\n/).map(part => part.trim()).find(part => part && !/^(#|>|```|[-*|]|!\[|\d+\.)/.test(part))
  return paragraph ? plainText(paragraph) : ''
}

function summary(text, length = 200) {
  if (text.length <= length) return text
  const cut = text.slice(0, length)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,.;:]$/, '') + '…'
}

/** Resolve a relative `href` against the content file `from` (`docs/a/b.md`), keeping its extension. */
export function resolvePath(href, from) {
  const parts = from.split('/').slice(0, -1)
  for (const part of href.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return '/' + parts.join('/')
}

/** Resolve `../a/b.md#x` against `docs/c/d.md` to `/docs/a/b#x`. Other links are unchanged. */
export function contentLink(href, from) {
  if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(href)) return href
  const [target, hash] = href.split('#')
  if (!target.endsWith('.md')) return href
  const path = resolvePath(target, from).replace(/\.md$/, '').replace(/\/index$/, '') || '/'
  return path + (hash ? '#' + hash : '')
}

/**
 * Render Markdown to HTML with heading anchors, GitHub-style callouts,
 * screenshot slots (`![alt](screenshot:name "caption")`) and content links.
 * `link(href)` rewrites relative links; `screenshots` maps slot names to
 * image URLs that exist.
 */
export function renderMarkdown(markdown, { link = href => href, screenshots = new Map() } = {}) {
  const toc = []
  const used = new Map()
  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        let id = slugify(inner) || 'section'
        const count = used.get(id) || 0
        used.set(id, count + 1)
        if (count) id += '-' + count
        if (depth === 2 || depth === 3) toc.push({ id, text: plainText(stripTags(inner)), depth })
        return `<h${depth} id="${id}"><a class="heading-anchor" href="#${id}">${inner}</a></h${depth}>\n`
      },
      link({ href, title, tokens }) {
        const target = link(href)
        const external = /^https?:/i.test(target) && !target.startsWith(SITE.origin)
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}${external ? ' rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`
      },
      image({ href, title, text }) {
        const caption = title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ''
        if (href.startsWith('screenshot:')) {
          const name = href.slice('screenshot:'.length)
          const source = screenshots.get(name)
          if (source) return `<figure class="doc-shot"><img src="${escapeHtml(source)}" alt="${escapeHtml(text)}" loading="lazy" decoding="async">${caption}</figure>`
          return `<figure class="doc-shot doc-shot-missing"><div class="doc-shot-frame" role="img" aria-label="${escapeHtml(text)}"><span class="doc-shot-label">Screenshot coming soon</span><span class="doc-shot-alt">${escapeHtml(text)}</span></div>${caption}</figure>`
        }
        return `<img src="${escapeHtml(link(href))}" alt="${escapeHtml(text)}" loading="lazy" decoding="async">`
      },
    },
  })
  let html = marked.parse(markdown)
  html = html.replace(/<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/g, (_, kind) =>
    `<blockquote class="callout callout-${kind.toLowerCase()}"><p class="callout-title">${CALLOUTS[kind]}</p><p>`)
    .replace(/<p>\s*<\/p>/g, '').replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>')
  return { html, toc }
}

/** Markdown for agents: absolute links, `.md` targets for our content, screenshot slots as text. */
export function agentMarkdown(markdown, from, { title, description, url }) {
  const body = markdown
    .replace(/!\[([^\]]*)\]\(screenshot:[^)\s]+(?:\s+"([^"]*)")?\)/g, (_, alt, caption) => `[Screenshot: ${alt}${caption ? ` (${caption})` : ''}]`)
    .replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text, href) => {
      if (!/^[^:#]+\.md(?:#|$)/.test(href) || href.startsWith('/')) return whole
      const [path, hash] = contentLink(href, from).split('#')
      return `[${text}](${SITE.origin}${path === '/' ? '' : path}.md${hash ? '#' + hash : ''})`
    })
  return `# ${title}\n\n${description ? `> ${description}\n\n` : ''}Source: ${SITE.origin}${url}\n\n${body.trim()}\n`
}

export function docEntry(file, source) {
  const { data, body } = parseFrontmatter(source)
  const slug = file.replace(/\.md$/, '').replace(/(^|\/)index$/, '')
  const section = slug.includes('/') ? slug.split('/')[0] : ''
  return {
    file: 'docs/' + file,
    slug,
    url: slug ? `/docs/${slug}` : '/docs',
    section,
    title: data.title || slug,
    description: data.description || firstParagraph(body),
    order: typeof data.order === 'number' ? data.order : 999,
    body,
  }
}

/** Order docs by section and `order`, and build the sidebar. */
export function buildDocs(entries) {
  const sectionIndex = new Map(DOC_SECTIONS.map((section, index) => [section.id, index]))
  const pages = entries.filter(entry => !entry.section || sectionIndex.has(entry.section)).sort((a, b) =>
    (a.section ? sectionIndex.get(a.section) + 1 : 0) - (b.section ? sectionIndex.get(b.section) + 1 : 0)
    || a.order - b.order || a.title.localeCompare(b.title))
  const navigation = DOC_SECTIONS.map(section => ({
    id: section.id,
    title: section.title,
    pages: pages.filter(page => page.section === section.id).map(page => ({ title: page.title, url: page.url })),
  })).filter(section => section.pages.length)
  return { pages, navigation }
}

export function blogEntry(file, source) {
  const { data, body } = parseFrontmatter(source)
  const slug = file.replace(/\.md$/, '')
  return {
    file: 'blog/' + file,
    slug,
    url: `/blog/${slug}`,
    title: data.title || slug,
    description: data.description || summary(firstParagraph(body)),
    date: String(data.date || ''),
    author: data.author || SITE.publisher,
    body,
  }
}

export function sortBlog(entries) {
  return entries.filter(entry => !entry.draft).sort((a, b) => b.date.localeCompare(a.date))
}

const VERSION_FILE = /^v(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?\.md$/

export function compareVersions(a, b) {
  const parse = value => { const [core, pre] = value.split('-'); return { core: core.split('.').map(Number), pre } }
  const left = parse(a), right = parse(b)
  for (let index = 0; index < 3; index++) if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index]
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre.localeCompare(right.pre, 'en', { numeric: true })
}

/** A published release note from `docs/release-notes/v<version>.md`. */
export function releaseEntry(file, source, dates = {}) {
  const match = VERSION_FILE.exec(file)
  if (!match) return null
  const version = file.slice(1, -3)
  const body = source.replace(/^#\s+.*\r?\n+/, '')
  return {
    file: 'docs/release-notes/' + file,
    version,
    url: `/changelog/v${version}`,
    title: `L4 ${version}`,
    description: summary(firstParagraph(body), 220),
    date: dates[version] || '',
    prerelease: Boolean(match[4]),
    body,
  }
}

export function sortReleases(entries) {
  return entries.filter(Boolean).sort((a, b) => compareVersions(b.version, a.version))
}

/** Release notes link to repository files; keep those links on GitHub at the release tag. */
export function releaseLink(version) {
  return href => {
    if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) return href
    const [target, hash] = href.split('#')
    const path = href.startsWith('/') ? target : resolvePath(target, 'docs/release-notes/x.md')
    return `${SITE.repo}/blob/v${version}${path}${hash ? '#' + hash : ''}`
  }
}

function xml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function robotsTxt() {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /servers\nDisallow: /domain\n\nSitemap: ${SITE.origin}/sitemap.xml\n`
}

export function sitemapXml(urls) {
  const items = urls.map(({ url, date }) => `  <url><loc>${xml(SITE.origin + (url === '/' ? '/' : url))}</loc>${date ? `<lastmod>${xml(date)}</lastmod>` : ''}</url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join('\n')}\n</urlset>\n`
}

export function rssXml({ title, description, url, feedUrl, items }) {
  const entries = items.map(item => `    <item>
      <title>${xml(item.title)}</title>
      <link>${xml(SITE.origin + item.url)}</link>
      <guid isPermaLink="true">${xml(SITE.origin + item.url)}</guid>
      ${item.date ? `<pubDate>${new Date(item.date + 'T12:00:00Z').toUTCString()}</pubDate>` : ''}
      <description>${xml(item.description)}</description>
    </item>`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(title)}</title>
    <link>${xml(SITE.origin + url)}</link>
    <description>${xml(description)}</description>
    <language>en</language>
    <atom:link href="${xml(SITE.origin + feedUrl)}" rel="self" type="application/rss+xml"/>
${entries.join('\n')}
  </channel>
</rss>
`
}

function llmsLine(entry) {
  return `- [${entry.title}](${SITE.origin}${entry.url === '/docs' ? '/docs' : entry.url}.md)${entry.description ? `: ${entry.description}` : ''}`
}

/** `/llms.txt`: what L4 is and where the agent-readable pages are. */
export function llmsTxt({ docs, blog, releases }) {
  const latest = releases[0]
  return `# ${SITE.name}

> ${SITE.description}

L4 is MIT licensed software by ${SITE.publisher} (${SITE.publisherUrl}). There is no hosted L4 service: every Server is deployed to its operator's own Cloudflare account or VPS and owns its Accounts, Members, Roles, content, files and realtime state. People and AI Agents are both Members of a Server; Agents act only within the Roles and Project policies they are given. llll.gg serves this site, the Shell (device-local bookmarks of Servers you use) and the installer at ${SITE.origin}/create.${latest ? ` The current release is ${latest.version}.` : ''}

Every documentation, blog and changelog page is also available as Markdown: append \`.md\` to its URL or request it with \`Accept: text/markdown\`.

## Docs

- [Documentation index](${SITE.origin}/docs/llms.txt): Every documentation page with a one-line description
- [Full documentation](${SITE.origin}/docs/llms-full.txt): All documentation pages in one file
${docs.pages.filter(page => page.section === 'get-started').map(llmsLine).join('\n')}

## Product

- [Home](${SITE.origin}/): What L4 is and how to run it
- [Create a Server](${SITE.origin}/create): Install L4 on your Cloudflare account or a VPS, or connect an existing Server
- [Changelog](${SITE.origin}/changelog): Release notes for every published version
${blog.length ? `- [Blog](${SITE.origin}/blog): Announcements and write-ups\n` : ''}
## Optional

- [GitHub repository](${SITE.repo}): Source code, issues and releases
- [Changelog feed](${SITE.origin}/changelog/rss.xml): RSS feed of releases
`
}

/** `/docs/llms.txt`: the documentation index, grouped like the sidebar. */
export function docsLlmsTxt(docs) {
  const groups = docs.navigation.map(section => `## ${section.title}\n\n${docs.pages.filter(page => page.section === section.id).map(llmsLine).join('\n')}`)
  const home = docs.pages.find(page => page.slug === '')
  return `# ${SITE.name} documentation

> ${SITE.description}

${home ? llmsLine(home) + '\n' : ''}- [Full documentation](${SITE.origin}/docs/llms-full.txt): All pages below in one file

${groups.join('\n\n')}
`
}

export function docsLlmsFull(docs) {
  return docs.pages.map(page => agentMarkdown(page.body, page.file, page)).join('\n---\n\n')
}

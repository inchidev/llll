import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { agentMarkdown, compareVersions, contentLink, docEntry, indexMarkdown, releaseEntry, releaseLink, renderMarkdown, robotsTxt, sitemapXml } from '../../apps/site/lib/content.mjs'
import { readSiteContent } from '../../apps/site/lib/content-files.mjs'
import { contentMarkdownPath } from '../../apps/site/src/index'

describe('site content', () => {
  it('resolves relative Markdown links to site paths', () => {
    expect(contentLink('../cloudflare/access.md#oauth', 'docs/get-started/create.md')).toBe('/docs/cloudflare/access#oauth')
    expect(contentLink('first-agent.md', 'docs/get-started/create.md')).toBe('/docs/get-started/first-agent')
    expect(contentLink('../index.md', 'docs/get-started/create.md')).toBe('/docs')
    expect(contentLink('https://example.com/a.md', 'docs/a.md')).toBe('https://example.com/a.md')
    expect(contentLink('/create', 'docs/a.md')).toBe('/create')
    expect(releaseLink('0.3.4')('../deployment.md#x')).toBe('https://github.com/inchidev/llll/blob/v0.3.4/docs/deployment.md#x')
  })

  it('renders headings, callouts, tables and screenshot slots', () => {
    const { html, toc } = renderMarkdown([
      '## Before you begin', '', '> [!WARNING]', '> Keep backups.', '', '### Before you begin', '',
      '| a | b |', '| - | - |', '| 1 | 2 |', '',
      '![The Create page with Cloudflare selected](screenshot:create-tab "Create a Server")',
      '![Existing](screenshot:exists)', '', '[Access](../cloudflare/access.md)',
    ].join('\n'), { link: href => contentLink(href, 'docs/get-started/x.md'), screenshots: new Map([['exists', '/docs/screenshots/exists.png']]) })
    expect(toc).toEqual([{ id: 'before-you-begin', text: 'Before you begin', depth: 2 }, { id: 'before-you-begin-1', text: 'Before you begin', depth: 3 }])
    expect(html).toContain('<blockquote class="callout callout-warning"><p class="callout-title">Warning</p>')
    expect(html).toContain('<div class="table-wrap"><table>')
    expect(html).toContain('role="img" aria-label="The Create page with Cloudflare selected"')
    expect(html).toContain('<figcaption>Create a Server</figcaption>')
    expect(html).toContain('<img src="/docs/screenshots/exists.png"')
    expect(html).toContain('href="/docs/cloudflare/access"')
  })

  it('writes Markdown for agents with absolute .md links and text for screenshot slots', () => {
    const page = docEntry('get-started/x.md', '---\ntitle: X\ndescription: Y\n---\n\nSee [Access](../cloudflare/access.md) and [create](/create).\n\n![Alt](screenshot:a "Cap")\n')
    expect(agentMarkdown(page.body, page.file, page)).toBe('# X\n\n> Y\n\nSource: https://llll.gg/docs/get-started/x\n\nSee [Access](https://llll.gg/docs/cloudflare/access.md) and [create](/create).\n\n[Screenshot: Alt (Cap)]\n')
  })

  it('orders release versions and strips the release title', () => {
    expect(['0.2.10', '0.2.9', '0.3.0', '0.2.0-alpha.8', '0.2.0-alpha.10', '0.2.0'].sort(compareVersions))
      .toEqual(['0.2.0-alpha.8', '0.2.0-alpha.10', '0.2.0', '0.2.9', '0.2.10', '0.3.0'])
    const release = releaseEntry('v0.3.4.md', '# L4 0.3.4\n\nThis release adds things.\n\n## Agents\n', { '0.3.4': '2026-10-29' })
    expect(release).toMatchObject({ version: '0.3.4', url: '/changelog/v0.3.4', date: '2026-10-29', description: 'This release adds things.', prerelease: false })
    expect(release!.body.startsWith('This release')).toBe(true)
  })

  it('lists blog and changelog entries in their Markdown index', () => {
    const release = releaseEntry('v0.3.4.md', '# L4 0.3.4\n\nThis release adds things.\n', { '0.3.4': '2026-10-29' })!
    expect(indexMarkdown({ title: 'L4 changelog', description: 'Releases.', url: '/changelog', items: [release] }))
      .toBe('# L4 changelog\n\n> Releases.\n\nSource: https://llll.gg/changelog\n\n- [L4 0.3.4](https://llll.gg/changelog/v0.3.4.md) (2026-10-29): This release adds things.\n')
  })

  it('negotiates Markdown only for content pages', () => {
    expect(contentMarkdownPath('/docs/get-started/x', 'text/markdown, text/html')).toBe('/docs/get-started/x.md')
    expect(contentMarkdownPath('/docs', 'text/markdown')).toBe('/docs.md')
    expect(contentMarkdownPath('/docs/get-started/x', 'text/html')).toBeNull()
    expect(contentMarkdownPath('/docs/x.md', null)).toBe('/docs/x.md')
    expect(contentMarkdownPath('/docs/llms.txt', 'text/markdown')).toBeNull()
    expect(contentMarkdownPath('/create', 'text/markdown')).toBeNull()
    expect(contentMarkdownPath('/', 'text/markdown')).toBe('/llms.txt')
    expect(contentMarkdownPath('/', 'text/html')).toBeNull()
  })

  it('declares Content Signals in robots.txt', () => {
    expect(robotsTxt()).toMatch(/^User-agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=no\n/)
  })

  it('escapes sitemap URLs', () => {
    expect(sitemapXml([{ url: '/' }, { url: '/a?b&c', date: '2026-10-29' }])).toContain('<url><loc>https://llll.gg/a?b&amp;c</loc><lastmod>2026-10-29</lastmod></url>')
  })

  it('has a publication date for the current version and valid docs links', () => {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version
    const dates = JSON.parse(readFileSync('apps/site/content/release-dates.json', 'utf8'))
    expect(dates[version], 'add the release date to apps/site/content/release-dates.json in the release PR').toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const { docs, blog } = readSiteContent()
    const urls = new Set(docs.pages.map(page => page.url))
    const broken = [...docs.pages, ...blog].flatMap(page => [...page.body.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+\.md(?:#[^)\s]*)?)\)/g)]
      .map(match => contentLink(match[1], page.file).split('#')[0]).filter(url => url.startsWith('/docs') && !urls.has(url)).map(url => `${page.file} → ${url}`))
    expect(broken).toEqual([])
    for (const page of docs.pages) expect(page.description.length, page.file).toBeGreaterThan(20)
  })
})

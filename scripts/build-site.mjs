import { spawnSync } from 'node:child_process'
import { readdir, readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { readSiteContent } from '../apps/site/lib/content-files.mjs'
import { agentMarkdown, docsLlmsFull, docsLlmsTxt, indexMarkdown, llmsTxt, robotsTxt, rssXml, SITE, sitemapXml, slugify } from '../apps/site/lib/content.mjs'
const root = resolve(import.meta.dirname, '..')
const generated = spawnSync('pnpm', ['exec', 'nuxt', 'generate', 'apps/site'], { cwd: root, stdio: 'inherit' })
if (generated.status !== 0) process.exit(generated.status || 1)
const output = resolve(root, 'apps/site/.output/public')
// Only the release workflow provides a pinned VPS installer. Feature Previews
// return 404 here rather than offering unreleased code to root shells.
if (process.env.LLLL_VPS_INSTALLER) await copyFile(resolve(process.env.LLLL_VPS_INSTALLER), resolve(output, 'install.sh'))
// Crawler and agent files: every content page as Markdown (also served for
// `Accept: text/markdown`), llms.txt indexes, the sitemap, robots and feeds.
const content = readSiteContent()
async function emit(path, text) { await mkdir(dirname(output + path), { recursive: true }); await writeFile(output + path, text) }
for (const page of content.docs.pages) await emit(page.url + '.md', agentMarkdown(page.body, page.file, page))
for (const post of content.blog) await emit(post.url + '.md', agentMarkdown(post.body, post.file, post))
for (const release of content.releases) await emit(release.url + '.md', agentMarkdown(release.body, release.file, release))
await emit('/blog.md', indexMarkdown({ title: `${SITE.name} blog`, description: 'Announcements and write-ups about L4.', url: '/blog', items: content.blog }))
await emit('/changelog.md', indexMarkdown({ title: `${SITE.name} changelog`, description: 'Release notes for every published version of L4.', url: '/changelog', items: content.releases }))
await emit('/llms.txt', llmsTxt(content))
await emit('/docs/llms.txt', docsLlmsTxt(content.docs))
await emit('/docs/llms-full.txt', docsLlmsFull(content.docs))
await emit('/docs/search.json', JSON.stringify(content.docs.pages.map(page => ({
  title: page.slug ? page.title : 'Documentation', description: page.description, url: page.url,
  section: content.docs.navigation.find(section => section.id === page.section)?.title || 'Docs',
  headings: [...page.body.matchAll(/^##\s+(.+)$/gm)].map(match => ({ text: match[1].replace(/[`*_]/g, '').trim(), id: slugify(match[1].trim()) })),
}))))
await emit('/robots.txt', robotsTxt())
await emit('/sitemap.xml', sitemapXml([
  { url: '/' }, { url: '/create' }, { url: '/privacy' }, { url: '/terms' },
  ...content.docs.pages.map(page => ({ url: page.url })),
  { url: '/blog', date: content.blog[0]?.date }, ...content.blog.map(post => ({ url: post.url, date: post.date })),
  { url: '/changelog', date: content.releases[0]?.date }, ...content.releases.map(release => ({ url: release.url, date: release.date })),
]))
await emit('/blog/rss.xml', rssXml({ title: `${SITE.name} blog`, description: 'Announcements and write-ups about L4.', url: '/blog', feedUrl: '/blog/rss.xml', items: content.blog }))
await emit('/changelog/rss.xml', rssXml({ title: `${SITE.name} releases`, description: 'Release notes for every published version of L4.', url: '/changelog', feedUrl: '/changelog/rss.xml', items: content.releases }))

async function paths(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await paths(resolve(directory, entry.name), prefix + '/' + entry.name))
    else if (!entry.name.endsWith('.map')) result.push(prefix + '/' + entry.name)
  }
  return result
}
const assets = (await paths(output)).filter(path => path.startsWith('/_nuxt/') || ['/200.html', '/favicon.svg', '/site.webmanifest'].includes(path))
const hash = createHash('sha256'); for (const path of assets) hash.update(await readFile(output + path))
const cache = 'llll-shell-' + hash.digest('hex').slice(0, 16)
await writeFile(output + '/sw.js', `const CACHE=${JSON.stringify(cache)},ASSETS=${JSON.stringify(assets)};
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS.map(path=>new Request(path,{cache:'reload'}))))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>(k.startsWith('llll-shell-')||k.startsWith('l4-shell-'))&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/')||u.pathname.startsWith('/deploy'))return;if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match('/200.html')));return;}if(ASSETS.includes(u.pathname))e.respondWith(caches.match(u.pathname).then(r=>r||fetch(e.request)));});`)
await build({ entryPoints: [resolve(root, 'apps/site/src/index.ts')], outfile: resolve(root, 'apps/site/.bundle/index.mjs'), bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', minify: true })
console.log(`Built independent L4 site, iframe shell and PWA (${assets.length} public assets, ${content.docs.pages.length} docs pages, ${content.blog.length} posts, ${content.releases.length} releases)`)

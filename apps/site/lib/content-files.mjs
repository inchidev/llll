// Reads the site's content from the repository at build time (Nuxt config,
// prerender and scripts/build-site.mjs). Docs and blog live in
// apps/site/content; the changelog is the published docs/release-notes.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blogEntry, buildDocs, docEntry, releaseEntry, sortBlog, sortReleases } from './content.mjs'

/** apps/site. Bundled prerender code cannot rely on its own location, so pages pass this from server-only runtime config. */
export function siteRoot() { return resolve(dirname(fileURLToPath(import.meta.url)), '..') }

function markdownFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

function read(directory, file) { return readFileSync(join(directory, file), 'utf8') }

/** Screenshot slot name → public URL, for images that exist. */
export function readScreenshots(root = siteRoot()) {
  const result = new Map()
  const directory = join(root, 'public/docs/screenshots')
  if (!existsSync(directory)) return result
  for (const name of readdirSync(directory)) {
    const match = /^(.+)\.(?:png|jpe?g|webp|avif)$/i.exec(name)
    if (match) result.set(match[1], `/docs/screenshots/${name}`)
  }
  return result
}

const cache = new Map()
/** All content, read once per process. */
export function readSiteContent(root = siteRoot()) {
  if (cache.has(root)) return cache.get(root)
  const content = join(root, 'content')
  const docsDirectory = join(content, 'docs')
  const blogDirectory = join(content, 'blog')
  const releaseDirectory = join(root, '../../docs/release-notes')
  const datesFile = join(content, 'release-dates.json')
  const dates = existsSync(datesFile) ? JSON.parse(readFileSync(datesFile, 'utf8')) : {}
  const result = {
    docs: buildDocs(markdownFiles(docsDirectory).map(file => docEntry(file, read(docsDirectory, file)))),
    blog: sortBlog(markdownFiles(blogDirectory).map(file => blogEntry(file, read(blogDirectory, file)))),
    // A release appears once release-dates.json records its publication date;
    // notes for versions that were never published stay out of the changelog.
    releases: sortReleases(markdownFiles(releaseDirectory).map(file => releaseEntry(file, read(releaseDirectory, file), dates))).filter(release => release.date),
    screenshots: readScreenshots(root),
  }
  cache.set(root, result)
  return result
}

/** Every prerendered content route. */
export function contentRoutes() {
  const { docs, blog, releases } = readSiteContent()
  return ['/docs', ...docs.pages.map(page => page.url), '/blog', ...blog.map(post => post.url), '/changelog', ...releases.map(release => release.url)]
    .filter((route, index, all) => all.indexOf(route) === index)
}

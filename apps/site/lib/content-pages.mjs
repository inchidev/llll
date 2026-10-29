// Render-ready data for the prerendered Docs, Blog and Changelog pages. Pages
// import this only on the server during `nuxt generate`; the browser receives
// the result through Nuxt's payload, never Markdown or the renderer.
import { contentLink, releaseLink, renderMarkdown, DOC_SECTIONS } from './content.mjs'
import { readSiteContent } from './content-files.mjs'

const markdownPath = url => `${url}.md`
let siteRoot
/** Set once by the page before loading content (see nuxt.config `runtimeConfig.siteRoot`). */
export function setSiteRoot(root) { siteRoot = root }
const content = () => readSiteContent(siteRoot)

function rendered(entry, link) {
  const { screenshots } = content()
  return renderMarkdown(entry.body, { link, screenshots })
}

export function docPage(slug) {
  const { docs } = content()
  const index = docs.pages.findIndex(page => page.slug === slug)
  if (index < 0) return null
  const page = docs.pages[index]
  const { html, toc } = rendered(page, href => contentLink(href, page.file))
  const brief = entry => entry && entry.slug ? { title: entry.title, url: entry.url } : null
  return {
    title: page.title,
    description: page.description,
    url: page.url,
    markdownPath: markdownPath(page.url),
    file: page.file,
    section: page.section,
    sectionTitle: DOC_SECTIONS.find(section => section.id === page.section)?.title || '',
    html,
    toc,
    navigation: docs.navigation,
    // The docs home leads into the first guide; guides do not lead back to it.
    previous: index > 1 ? brief(docs.pages[index - 1]) : null,
    next: brief(docs.pages[index + 1]),
  }
}

export function blogIndex() {
  return content().blog.map(({ title, description, date, author, url }) => ({ title, description, date, author, url }))
}

export function blogPost(slug) {
  const post = content().blog.find(entry => entry.slug === slug)
  if (!post) return null
  const { html, toc } = rendered(post, href => contentLink(href, post.file))
  return { title: post.title, description: post.description, date: post.date, author: post.author, url: post.url, markdownPath: markdownPath(post.url), html, toc }
}

export function changelogIndex() {
  const releases = content().releases
  return releases.map((release, index) => ({
    version: release.version,
    title: release.title,
    description: release.description,
    date: release.date,
    url: release.url,
    prerelease: release.prerelease,
    // The newest release is shown in full; older ones link to their own page.
    html: index === 0 ? rendered(release, releaseLink(release.version)).html : '',
  }))
}

export function releasePage(version) {
  const releases = content().releases
  const index = releases.findIndex(release => release.version === version)
  if (index < 0) return null
  const release = releases[index]
  const brief = entry => entry ? { title: entry.title, url: entry.url } : null
  return {
    version: release.version,
    title: release.title,
    description: release.description,
    date: release.date,
    url: release.url,
    markdownPath: markdownPath(release.url),
    prerelease: release.prerelease,
    html: rendered(release, releaseLink(release.version)).html,
    newer: brief(releases[index - 1]),
    older: brief(releases[index + 1]),
  }
}

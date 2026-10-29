import { SITE } from '../../lib/site.mjs'

export interface SitePage {
  title: string
  description: string
  path: string
  type?: 'website' | 'article'
  /** Markdown copy of this page for agents (`/docs/x.md`). */
  markdownPath?: string
  published?: string
  breadcrumbs?: { name: string, path: string }[]
  /** Extra schema.org object merged into the page's JSON-LD graph. */
  schema?: Record<string, unknown>
}

/** Title, description, canonical, Open Graph, Markdown alternate and JSON-LD for one public page. */
export function useSitePage(page: MaybeRefOrGetter<SitePage | null | undefined>) {
  const current = computed(() => toValue(page))
  const url = computed(() => current.value ? SITE.origin + current.value.path : SITE.origin)
  const title = computed(() => current.value ? `${current.value.title} · ${SITE.name}` : SITE.name)
  const image = `${SITE.origin}/og-image.png`
  useSeoMeta({
    title,
    description: () => current.value?.description,
    ogTitle: title,
    ogDescription: () => current.value?.description,
    ogType: () => current.value?.type || 'website',
    ogUrl: url,
    ogSiteName: SITE.name,
    ogImage: image,
    ogImageWidth: 1200,
    ogImageHeight: 630,
    twitterCard: 'summary_large_image',
    twitterTitle: title,
    twitterDescription: () => current.value?.description,
    twitterImage: image,
    articlePublishedTime: () => current.value?.published,
  })
  useHead(() => {
    const value = current.value
    if (!value) return {}
    const graph: Record<string, unknown>[] = []
    if (value.breadcrumbs?.length) graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: value.breadcrumbs.map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, name: crumb.name, item: SITE.origin + crumb.path })),
    })
    if (value.schema) graph.push({
      url: url.value,
      headline: value.title,
      description: value.description,
      publisher: { '@type': 'Organization', name: SITE.publisher, url: SITE.publisherUrl },
      ...value.schema,
    })
    return {
      link: [
        { rel: 'canonical' as const, href: url.value },
        ...(value.markdownPath ? [{ rel: 'alternate' as const, type: 'text/markdown', href: SITE.origin + value.markdownPath }] : []),
      ],
      script: graph.length ? [{ type: 'application/ld+json', innerHTML: JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }) }] : [],
    }
  })
}

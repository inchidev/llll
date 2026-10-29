<script setup lang="ts">
interface DocLink { title: string, url: string }
interface DocPage {
  title: string, description: string, url: string, markdownPath: string, file: string, section: string, sectionTitle: string, html: string
  toc: { id: string, text: string, depth: number }[]
  navigation: { id: string, title: string, pages: DocLink[] }[]
  previous: DocLink | null, next: DocLink | null
}

const config = useRuntimeConfig()
const route = useRoute()
const slug = computed(() => ([] as string[]).concat(route.params.slug || []).filter(Boolean).join('/'))
const { data: page, error } = await useAsyncData(() => `doc:${slug.value}`, async () => {
  if (!import.meta.server) return null
  const { docPage, setSiteRoot } = await import('../../../lib/content-pages.mjs')
  setSiteRoot(config.siteRoot)
  return docPage(slug.value) as DocPage | null
}, { watch: [slug] })
if (error.value) throw error.value
if (!page.value) throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })

const isHome = computed(() => !slug.value)
useSitePage(() => page.value && {
  title: isHome.value ? 'Documentation' : page.value.title,
  description: page.value.description,
  path: page.value.url,
  type: isHome.value ? 'website' : 'article',
  markdownPath: page.value.markdownPath,
  breadcrumbs: [{ name: 'Docs', path: '/docs' }, ...(isHome.value ? [] : [
    ...(page.value.sectionTitle ? [{ name: page.value.sectionTitle, path: page.value.navigation.find(section => section.id === page.value!.section)?.pages[0]?.url || '/docs' }] : []),
    { name: page.value.title, path: page.value.url },
  ])],
  schema: isHome.value ? undefined : { '@type': 'TechArticle', isPartOf: { '@type': 'WebSite', name: 'L4 documentation', url: 'https://llll.gg/docs' } },
})

const sections = computed(() => (page.value?.navigation || []).map(section => ({ ...section, first: section.pages[0] })))
</script>

<template>
  <div v-if="page" class="min-h-screen bg-default text-default">
    <SiteHeader>
      <template #right><DocsSearch class="hidden md:inline-flex" /></template>
      <template #body>
        <DocsSearch class="my-4" />
        <DocsNav :navigation="page.navigation" :current="page.url" />
      </template>
    </SiteHeader>

    <UContainer class="max-w-(--ui-container)">
      <div class="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10 xl:grid-cols-[15rem_minmax(0,1fr)_13rem]">
        <aside class="hidden lg:block">
          <div class="sticky top-(--ui-header-height) max-h-[calc(100dvh-var(--ui-header-height))] overflow-y-auto py-8 pr-2">
            <DocsNav :navigation="page.navigation" :current="page.url" />
          </div>
        </aside>

        <main class="min-w-0 py-8 sm:py-12">
          <UBreadcrumb v-if="!isHome" :items="[{ label: 'Docs', to: '/docs' }, ...(page.sectionTitle ? [{ label: page.sectionTitle }] : [])]" class="mb-4" />
          <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <h1 class="text-3xl font-semibold text-highlighted sm:text-4xl">{{ isHome ? 'Documentation' : page.title }}</h1>
            <DocActions :markdown-path="page.markdownPath" :file="page.file" class="shrink-0" />
          </div>
          <p class="mt-4 max-w-2xl text-lg text-muted">{{ page.description }}</p>

          <div v-if="isHome" class="mt-10 grid gap-4 sm:grid-cols-2">
            <NuxtLink v-for="section in sections" :key="section.id" :to="section.first?.url" class="rounded-md border border-default p-5 hover:bg-elevated">
              <h2 class="text-lg font-semibold text-highlighted">{{ section.title }}</h2>
              <p class="mt-2 text-sm text-muted">{{ section.pages.map(item => item.title).join(' · ') }}</p>
            </NuxtLink>
          </div>

          <DocProse :html="page.html" class="mt-8" />

          <nav v-if="page.previous || page.next" aria-label="Previous and next page" class="mt-14 grid gap-4 border-t border-muted pt-8 sm:grid-cols-2">
            <NuxtLink v-if="page.previous" :to="page.previous.url" class="rounded-md border border-default p-4 hover:bg-elevated">
              <span class="text-xs text-dimmed">Previous</span><span class="mt-1 block font-medium text-highlighted">{{ page.previous.title }}</span>
            </NuxtLink>
            <span v-else />
            <NuxtLink v-if="page.next" :to="page.next.url" class="rounded-md border border-default p-4 text-right hover:bg-elevated">
              <span class="text-xs text-dimmed">Next</span><span class="mt-1 block font-medium text-highlighted">{{ page.next.title }}</span>
            </NuxtLink>
          </nav>
        </main>

        <aside v-if="page.toc.length" class="hidden xl:block">
          <nav aria-label="On this page" class="sticky top-(--ui-header-height) py-12 text-sm">
            <p class="mb-3 font-semibold text-highlighted">On this page</p>
            <ul class="space-y-2">
              <li v-for="item in page.toc" :key="item.id" :class="item.depth === 3 ? 'pl-3' : ''"><a :href="`#${item.id}`" class="text-muted hover:text-highlighted">{{ item.text }}</a></li>
            </ul>
          </nav>
        </aside>
      </div>
    </UContainer>
    <SiteFooter />
  </div>
</template>

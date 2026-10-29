<script setup lang="ts">
const config = useRuntimeConfig()
interface Release {
  version: string, title: string, description: string, date: string, url: string, markdownPath: string, prerelease: boolean, html: string
  newer: { title: string, url: string } | null, older: { title: string, url: string } | null
}

const route = useRoute()
const version = computed(() => String(route.params.version).replace(/^v/, ''))
const { data: release, error } = await useAsyncData(() => `release:${version.value}`, async () => {
  if (!import.meta.server) return null
  const { releasePage, setSiteRoot } = await import('../../../lib/content-pages.mjs')
  setSiteRoot(config.siteRoot)
  return releasePage(version.value) as Release | null
}, { watch: [version] })
if (error.value) throw error.value
if (!release.value) throw createError({ statusCode: 404, statusMessage: 'Release not found', fatal: true })

useSitePage(() => release.value && {
  title: release.value.title,
  description: release.value.description,
  path: release.value.url,
  type: 'article',
  markdownPath: release.value.markdownPath,
  published: release.value.date,
  breadcrumbs: [{ name: 'Changelog', path: '/changelog' }, { name: release.value.title, path: release.value.url }],
  schema: { '@type': 'TechArticle', datePublished: release.value.date, about: { '@type': 'SoftwareApplication', name: 'L4', softwareVersion: release.value.version } },
})
</script>

<template>
  <div v-if="release" class="min-h-screen bg-default text-default">
    <SiteHeader />
    <UContainer class="max-w-3xl py-12 sm:py-20">
      <UButton to="/changelog" label="Changelog" icon="i-ph-arrow-left" color="neutral" variant="link" class="-ml-2.5" />
      <article class="mt-6">
        <div class="flex flex-wrap items-center gap-3">
          <time :datetime="release.date" class="text-sm text-dimmed">{{ formatContentDate(release.date) }}</time>
          <UBadge v-if="release.prerelease" label="Prerelease" color="neutral" variant="outline" size="sm" />
        </div>
        <div class="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <h1 class="text-4xl font-semibold text-highlighted">{{ release.title }}</h1>
          <DocActions :markdown-path="release.markdownPath" class="shrink-0" />
        </div>
        <DocProse :html="release.html" class="mt-8" />
        <p class="mt-10 text-sm text-muted">Assets and checksums: <a :href="`https://github.com/inchidev/llll/releases/tag/v${release.version}`" class="text-primary underline underline-offset-4">GitHub release v{{ release.version }}</a></p>
      </article>
      <nav aria-label="Newer and older releases" class="mt-12 grid gap-4 border-t border-muted pt-8 sm:grid-cols-2">
        <NuxtLink v-if="release.older" :to="release.older.url" class="rounded-md border border-default p-4 hover:bg-elevated">
          <span class="text-xs text-dimmed">Older</span><span class="mt-1 block font-medium text-highlighted">{{ release.older.title }}</span>
        </NuxtLink>
        <span v-else />
        <NuxtLink v-if="release.newer" :to="release.newer.url" class="rounded-md border border-default p-4 text-right hover:bg-elevated">
          <span class="text-xs text-dimmed">Newer</span><span class="mt-1 block font-medium text-highlighted">{{ release.newer.title }}</span>
        </NuxtLink>
      </nav>
    </UContainer>
    <SiteFooter />
  </div>
</template>

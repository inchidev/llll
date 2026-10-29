<script setup lang="ts">
const config = useRuntimeConfig()
interface ReleaseSummary { version: string, title: string, description: string, date: string, url: string, prerelease: boolean, html: string }

const { data: releases, error } = await useAsyncData('changelog', async () => {
  if (!import.meta.server) return null
  const { changelogIndex, setSiteRoot } = await import('../../../lib/content-pages.mjs')
  setSiteRoot(config.siteRoot)
  return changelogIndex() as ReleaseSummary[]
})
if (error.value) throw error.value
const latest = computed(() => releases.value?.[0])
const older = computed(() => releases.value?.slice(1) || [])
useSitePage({ title: 'Changelog', description: 'Release notes for every published version of L4: Landing, Shell, installer, Server and Docs share one version.', path: '/changelog' })
useHead({ link: [{ rel: 'alternate', type: 'application/rss+xml', title: 'L4 releases', href: 'https://llll.gg/changelog/rss.xml' }] })
</script>

<template>
  <div class="min-h-screen bg-default text-default">
    <SiteHeader />
    <UContainer class="max-w-4xl py-12 sm:py-20">
      <div class="flex items-end justify-between gap-4">
        <h1 class="text-4xl font-semibold text-highlighted">Changelog</h1>
        <UButton to="/changelog/rss.xml" external target="_blank" label="RSS" icon="i-ph-rss" color="neutral" variant="ghost" />
      </div>
      <p class="mt-4 text-lg text-muted">Landing, Shell, installer, Server and Docs share one version. Your Servers update only when you choose an update. Releases are also on <a href="https://github.com/inchidev/llll/releases" class="text-primary underline underline-offset-4">GitHub</a>.</p>

      <article v-if="latest" class="mt-12 rounded-md border border-default p-6 sm:p-8">
        <div class="flex flex-wrap items-center gap-3">
          <UBadge label="Latest" variant="subtle" />
          <time :datetime="latest.date" class="text-sm text-dimmed">{{ formatContentDate(latest.date) }}</time>
        </div>
        <h2 class="mt-3 text-3xl font-semibold text-highlighted"><NuxtLink :to="latest.url" class="hover:underline">{{ latest.title }}</NuxtLink></h2>
        <DocProse :html="latest.html" class="mt-6" />
      </article>

      <h2 v-if="older.length" class="mt-16 text-xl font-semibold text-highlighted">Earlier releases</h2>
      <ol class="mt-4 divide-y divide-muted border-y border-muted">
        <li v-for="release in older" :key="release.version" class="py-6">
          <NuxtLink :to="release.url" class="group grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6">
            <div>
              <p class="font-semibold text-highlighted group-hover:underline">{{ release.version }}</p>
              <time :datetime="release.date" class="text-sm text-dimmed">{{ formatContentDate(release.date) }}</time>
              <UBadge v-if="release.prerelease" label="Prerelease" color="neutral" variant="outline" size="sm" class="mt-2" />
            </div>
            <p class="text-sm text-muted">{{ release.description }}</p>
          </NuxtLink>
        </li>
      </ol>
    </UContainer>
    <SiteFooter />
  </div>
</template>

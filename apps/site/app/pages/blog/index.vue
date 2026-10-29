<script setup lang="ts">
const config = useRuntimeConfig()
interface PostSummary { title: string, description: string, date: string, author: string, url: string }

const { data: posts, error } = await useAsyncData('blog', async () => {
  if (!import.meta.server) return null
  const { blogIndex, setSiteRoot } = await import('../../../lib/content-pages.mjs')
  setSiteRoot(config.siteRoot)
  return blogIndex() as PostSummary[]
})
if (error.value) throw error.value
useSitePage({ title: 'Blog', description: 'Announcements and write-ups about L4, the open-source workspace for humans and agents.', path: '/blog' })
useHead({ link: [{ rel: 'alternate', type: 'application/rss+xml', title: 'L4 blog', href: 'https://llll.gg/blog/rss.xml' }] })
</script>

<template>
  <div class="min-h-screen bg-default text-default">
    <SiteHeader />
    <UContainer class="max-w-4xl py-12 sm:py-20">
      <div class="flex items-end justify-between gap-4">
        <h1 class="text-4xl font-semibold text-highlighted">Blog</h1>
        <UButton to="/blog/rss.xml" external target="_blank" label="RSS" icon="i-ph-rss" color="neutral" variant="ghost" />
      </div>
      <p class="mt-4 text-lg text-muted">Announcements and write-ups about L4.</p>
      <ol class="mt-12 divide-y divide-muted border-y border-muted">
        <li v-for="post in posts || []" :key="post.url" class="py-8">
          <NuxtLink :to="post.url" class="group block">
            <time :datetime="post.date" class="text-sm text-dimmed">{{ formatContentDate(post.date) }}</time>
            <h2 class="mt-2 text-2xl font-semibold text-highlighted group-hover:underline">{{ post.title }}</h2>
            <p class="mt-3 text-muted">{{ post.description }}</p>
          </NuxtLink>
        </li>
      </ol>
      <p v-if="!posts?.length" class="mt-12 text-muted">No posts yet.</p>
    </UContainer>
    <SiteFooter />
  </div>
</template>

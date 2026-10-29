<script setup lang="ts">
const config = useRuntimeConfig()
interface Post { title: string, description: string, date: string, author: string, url: string, markdownPath: string, html: string }

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const { data: post, error } = await useAsyncData(() => `blog:${slug.value}`, async () => {
  if (!import.meta.server) return null
  const { blogPost, setSiteRoot } = await import('../../../lib/content-pages.mjs')
  setSiteRoot(config.siteRoot)
  return blogPost(slug.value) as Post | null
}, { watch: [slug] })
if (error.value) throw error.value
if (!post.value) throw createError({ statusCode: 404, statusMessage: 'Post not found', fatal: true })

useSitePage(() => post.value && {
  title: post.value.title,
  description: post.value.description,
  path: post.value.url,
  type: 'article',
  markdownPath: post.value.markdownPath,
  published: post.value.date,
  breadcrumbs: [{ name: 'Blog', path: '/blog' }, { name: post.value.title, path: post.value.url }],
  schema: { '@type': 'BlogPosting', datePublished: post.value.date, author: { '@type': 'Person', name: post.value.author } },
})
</script>

<template>
  <div v-if="post" class="min-h-screen bg-default text-default">
    <SiteHeader />
    <UContainer class="max-w-3xl py-12 sm:py-20">
      <UButton to="/blog" label="Blog" icon="i-ph-arrow-left" color="neutral" variant="link" class="-ml-2.5" />
      <article class="mt-6">
        <p class="text-sm text-dimmed"><time :datetime="post.date">{{ formatContentDate(post.date) }}</time> · {{ post.author }}</p>
        <h1 class="mt-3 text-4xl font-semibold text-highlighted sm:text-5xl">{{ post.title }}</h1>
        <p class="mt-5 text-xl text-muted">{{ post.description }}</p>
        <DocProse :html="post.html" class="mt-10" />
      </article>
    </UContainer>
    <SiteFooter />
  </div>
</template>

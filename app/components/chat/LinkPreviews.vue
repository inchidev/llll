<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { useIntersectionObserver } from '@vueuse/core'
import type { LinkPreview } from '~~/shared/link-previews'

const props = defineProps<{ urls: string[] }>()
const { api } = useApi()
const { serverId } = useServer()
const session = useSessionStore()
const container = ref<HTMLElement>()
const visible = ref(false)
useIntersectionObserver(container, ([entry]) => { visible.value = Boolean(entry?.isIntersecting) }, { rootMargin: '100px' })
const previews = useQuery({
  queryKey: computed(() => ['link-previews', serverId.value, session.user?.id, props.urls]),
  queryFn: ({ signal }) => api<{ previews: LinkPreview[] }>('/api/link-previews', { method: 'POST', body: { urls: props.urls }, signal }),
  enabled: computed(() => visible.value && Boolean(session.user) && props.urls.length > 0),
  staleTime: 0, gcTime: 0, retry: false,
  refetchInterval: computed(() => visible.value ? 60_000 : false),
})
const cards = computed(() => previews.isFetching.value || previews.error.value ? [] : previews.data.value?.previews ?? [])
const icons = { task: 'i-ph-check-square', item: 'i-ph-file-text', database: 'i-ph-table', website: 'i-ph-globe', conversation: 'i-ph-chats-circle', message: 'i-ph-chat-circle' }
const labels = { task: 'Task', item: 'Item', database: 'Database', conversation: 'Conversation', message: 'Message' }
function hostname(url: string) { try { return new URL(url).hostname } catch { return '' } }
</script>

<template>
  <div ref="container" class="min-h-px" @click.stop>
    <div v-if="cards.length" class="mt-2 flex max-w-lg flex-col gap-2">
      <NuxtLink v-for="card in cards" :key="card.url" :to="card.url" :external="card.kind === 'website'" :target="card.kind === 'website' ? '_blank' : undefined" :rel="card.kind === 'website' ? 'noopener noreferrer' : undefined" class="flex min-w-0 overflow-hidden rounded-lg border border-default bg-muted text-start no-underline hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
        <div class="min-w-0 flex-1 p-3">
          <div class="mb-1 flex items-center gap-1.5 text-xs text-muted"><UIcon :name="icons[card.kind]" class="size-3.5 shrink-0" /><span class="truncate">{{ card.kind === 'website' ? hostname(card.url) : labels[card.kind] }}</span><span v-if="card.status" class="ms-auto capitalize">{{ card.status }}</span></div>
          <p class="line-clamp-2 text-sm font-medium text-highlighted">{{ card.title }}</p>
          <p v-if="card.description" class="mt-1 line-clamp-2 text-xs text-muted">{{ card.description }}</p>
        </div>
        <div v-if="card.image" class="relative w-24 shrink-0 sm:w-32"><img :src="card.image" alt="" loading="lazy" class="absolute inset-0 size-full object-cover" referrerpolicy="no-referrer"></div>
      </NuxtLink>
    </div>
  </div>
</template>

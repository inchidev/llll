<script setup lang="ts">
const url = useRequestURL()
const image = `${url.origin}/og-image.png`
const { native } = useClientServers()
const embedded = useState('llll-embed', () => ({ parent: '', enabled: import.meta.client && window.parent !== window }))

useSeoMeta({
  ogTitle: 'L4',
  ogDescription: 'Independent communities, together on infrastructure you control.',
  ogImage: image,
  twitterCard: 'summary_large_image',
  twitterTitle: 'L4',
  twitterDescription: 'Independent communities, together on infrastructure you control.',
  twitterImage: image,
})
</script>

<template>
  <UApp :toaster="{ position: 'top-right', ui: { viewport: 'top-[max(1rem,env(safe-area-inset-top))]' } }">
    <NuxtRouteAnnouncer />
    <div class="flex h-dvh min-w-0 overflow-hidden bg-default">
      <ClientServerRail v-if="native && !embedded.enabled" />
      <div class="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <ClientUpdateBanner />
        <div class="min-h-0 flex-1 overflow-hidden"><NuxtLayout><NuxtPage /></NuxtLayout></div>
      </div>
    </div>
  </UApp>
</template>

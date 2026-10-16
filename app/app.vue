<script setup lang="ts">
const url = useRequestURL()
const image = `${url.origin}/og-image.png`
const { native } = useClientServers()

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
  <UApp>
    <NuxtRouteAnnouncer />
    <div v-if="native" class="flex h-dvh min-w-0 overflow-hidden bg-default">
      <ClientServerRail />
      <div class="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <ClientUpdateBanner />
        <div class="min-h-0 flex-1 overflow-hidden"><NuxtLayout><NuxtPage /></NuxtLayout></div>
      </div>
    </div>
    <NuxtLayout v-else>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>

<script setup lang="ts">
const session = useSessionStore()
const ui = useUiStore()
const { api } = useApi()

onMounted(async () => {
  if (!session.ready) await session.refresh(api)
  if (session.health && !session.health.ready) {
    await navigateTo('/setup')
    return
  }
  if (!session.user) {
    await navigateTo('/login')
    return
  }
  const last = ui.last()
  if (last) {
    await navigateTo(`/channels/${last.channelId}`)
    return
  }
  await navigateTo('/channels')
})
</script>

<template>
  <div class="flex h-full flex-col items-center justify-center gap-4" aria-busy="true">
    <BrandLogo size="xl" alt="L4" class="animate-pulse" />
    <span class="sr-only">Loading</span>
  </div>
</template>

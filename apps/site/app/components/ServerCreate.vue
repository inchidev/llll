<script setup lang="ts">
const route = useRoute()
const router = useRouter()
const items = [
  { label: 'Connect', value: 'connect', slot: 'connect' as const },
  { label: 'Cloudflare', value: 'cloudflare', slot: 'cloudflare' as const },
  { label: 'VPS', value: 'vps', slot: 'vps' as const },
]
const tab = computed({
  get: () => ['cloudflare', 'vps'].includes(String(route.query.tab)) ? String(route.query.tab) : 'connect',
  set: (value: string | number) => {
    void router.replace({ path: '/create', query: { ...route.query, tab: value === 'connect' ? undefined : String(value) }, hash: route.hash })
  },
})
const cloudflareOpened = ref(tab.value === 'cloudflare')
watch(tab, value => { if (value === 'cloudflare') cloudflareOpened.value = true })
</script>

<template>
  <div class="flex min-h-full flex-col">
    <header class="flex shrink-0 items-center border-b border-default px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-8">
      <h1 class="flex h-11 items-center text-xl font-semibold tracking-tight">Add a server</h1>
    </header>
    <div class="w-full max-w-xl px-4 py-6 sm:px-8 sm:py-8">
      <UTabs v-model="tab" :items="items" :unmount-on-hide="false" class="gap-6" :ui="{ list: 'w-full', trigger: 'flex-auto px-1 sm:px-3' }">
        <template #connect><ServerConnect /></template>
        <template #cloudflare><ServerDeploy v-if="cloudflareOpened" /></template>
        <template #vps><ServerVps /></template>
      </UTabs>
    </div>
  </div>
</template>

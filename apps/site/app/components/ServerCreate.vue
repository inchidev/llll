<script setup lang="ts">
const route = useRoute()
const router = useRouter()
const items = [
  { label: 'Connect', short: 'Connect', value: 'connect', slot: 'connect' as const },
  { label: 'New on Cloudflare', short: 'Cloudflare', value: 'cloudflare', slot: 'cloudflare' as const },
  { label: 'New on a VPS', short: 'VPS', value: 'vps', slot: 'vps' as const },
]
const tab = computed({
  get: () => ['cloudflare', 'vps'].includes(String(route.query.tab)) ? String(route.query.tab) : 'connect',
  set: (value: string | number) => {
    void router.replace({ path: '/create', query: { ...route.query, tab: value === 'connect' ? undefined : String(value) }, hash: route.hash })
  },
})
// Updating one Server is its own task: no create tabs, no other Servers.
const updating = computed(() => Boolean(route.query.update) || route.query.resume === 'update')
const cloudflareOpened = ref(tab.value === 'cloudflare')
watch(tab, value => { if (value === 'cloudflare') cloudflareOpened.value = true })
</script>

<template>
  <div class="flex min-h-full flex-col">
    <header class="flex shrink-0 items-center border-b border-default px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-8">
      <h1 class="flex h-11 items-center text-xl font-semibold tracking-tight">{{ updating ? 'Update a Server' : 'Add a Server' }}</h1>
    </header>
    <div v-if="updating" class="mx-auto w-full max-w-2xl px-4 py-6 sm:px-8 sm:py-8"><ServerDeploy /></div>
    <div v-else class="mx-auto w-full max-w-2xl px-4 py-6 sm:px-8 sm:py-8">
      <p class="mb-6 text-sm leading-6 text-muted">Open a Server you already use, or create your own on your Cloudflare account or VPS. Every Server keeps its own accounts and data.</p>
      <UTabs v-model="tab" :items="items" :unmount-on-hide="false" class="gap-6" :ui="{ list: 'w-full', trigger: 'flex-auto px-1 sm:px-3' }">
        <!-- Phones and Telegram leave about 300px beside the rail: short names there. -->
        <template #default="{ item }"><span class="sm:hidden">{{ item.short }}</span><span class="hidden sm:inline">{{ item.label }}</span></template>
        <template #connect><ServerConnect /></template>
        <template #cloudflare><ServerDeploy v-if="cloudflareOpened" /></template>
        <template #vps><ServerVps /></template>
      </UTabs>
    </div>
  </div>
</template>

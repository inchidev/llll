<script setup lang="ts">
import CommunityRail from '../../../packages/client-ui/CommunityRail.vue'

const servers = useServerLinks()
const ui = useUiStore()
const session = useSessionStore()
const address = ref('')
const adding = ref(false)
const error = ref('')
const here = import.meta.client ? location.origin : ''
const self = useState<{ id: string; name: string; iconUrl?: string | null } | null>('llll-server-link-self', () => null)
onMounted(async () => {
  const identity = await fetch('/.well-known/llll').then(response => response.json() as Promise<{ id: string; name: string; iconUrl?: string | null }>).catch(() => null)
  if (identity) self.value = { id: identity.id, name: identity.name, iconUrl: identity.iconUrl }
})
// Another address of this same Server is no other Server.
const others = computed(() => servers.links.value.filter(link => link.id !== self.value?.id))
const groups = computed(() => [
  ...(self.value ? [{ origin: here, name: self.value.name, servers: [self.value] }] : []),
  ...others.value.map(link => ({ origin: link.origin, name: link.name, servers: [{ id: link.id, name: link.name }] })),
])
// On a phone the rail joins the navigation drawer, and the page has it whole otherwise.
const onPhone = computed(() => !session.user || ui.mobilePane === 'channels')
function open(origin: string) {
  const link = servers.links.value.find(item => item.origin === origin)
  if (link) servers.open(link)
}
async function submit() {
  adding.value = true
  error.value = ''
  try {
    await servers.add(address.value)
    address.value = ''
    servers.adding.value = false
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not add this Server' }
  finally { adding.value = false }
}
watch(servers.adding, (open) => { if (open) error.value = '' })
const host = (origin: string) => new URL(origin).host
const offeredHost = computed(() => servers.offered.value ? host(servers.offered.value.origin) : '')
</script>

<template>
  <div v-if="others.length" class="shrink-0" :class="onPhone ? 'block' : 'hidden md:block'">
    <CommunityRail :groups="groups" :active-origin="here" :active-server-id="self?.id" home-label="This Server" @server="open" @connect="servers.adding.value = true" />
  </div>
  <UModal v-model:open="servers.adding.value" title="Add a Server" description="This browser keeps the list on this Server's address, and no other Server sees it. You sign in to each Server separately.">
    <template #body>
      <form class="space-y-4" @submit.prevent="submit">
        <UFormField label="Address" :error="error || undefined"><UInput v-model="address" placeholder="chat.example.com" autocomplete="url" autocapitalize="none" class="w-full" autofocus /></UFormField>
        <ul v-if="servers.links.value.length" class="divide-y divide-default">
          <li v-for="link in servers.links.value" :key="link.origin" class="flex items-center justify-between gap-3 py-2 text-sm">
            <span class="min-w-0 truncate">{{ link.name }} <span class="text-muted">{{ host(link.origin) }}</span></span>
            <UButton icon="i-ph-x" color="neutral" variant="ghost" size="sm" :aria-label="`Remove ${link.name}`" @click="servers.remove(link.origin)" />
          </li>
        </ul>
        <div class="flex justify-end"><UButton type="submit" label="Add" :loading="adding" :disabled="!address.trim()" /></div>
      </form>
    </template>
  </UModal>
  <UModal :open="Boolean(servers.offered.value)" title="Add the way back?" :description="`You came here from ${servers.offered.value?.name}. Check the address before you add it.`" @update:open="(open: boolean) => { if (!open) servers.declineOffer() }">
    <template #body>
      <p class="break-all text-sm font-medium text-highlighted">{{ offeredHost }}</p>
      <div class="mt-4 flex justify-end gap-2">
        <UButton label="Not now" color="neutral" variant="ghost" @click="servers.declineOffer()" />
        <UButton label="Add" @click="servers.acceptOffer()" />
      </div>
    </template>
  </UModal>
</template>

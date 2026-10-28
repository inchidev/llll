<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { MemberDTO } from '~~/shared/types'

const ui = useUiStore()
const nav = useNavActions()
const { serverId } = useServer()
const members = useQuery({
  queryKey: computed(() => ['members', serverId.value]),
  queryFn: () => plainFetch<{ members: MemberDTO[] }>(`/api/servers/${serverId.value}/members`),
  enabled: computed(() => ui.liveSetupOpen && Boolean(serverId.value)),
})
const { mine } = usePermissions(() => members.data.value?.members)
const isOwner = computed(() => mine.value?.role.key === 'owner')

function openSettings() {
  ui.liveSetupOpen = false
  nav.openServerSettings('live')
}
</script>

<template>
  <UModal v-model:open="ui.liveSetupOpen" title="Live isn't connected yet">
    <template #body>
      <p v-if="isOwner" class="text-sm text-muted">
        Calls and live sessions run on Cloudflare RealtimeKit. Connect it once with a Cloudflare API token and every conversation can go live.
      </p>
      <p v-else class="text-sm text-muted">
        Calls and live sessions need Cloudflare RealtimeKit. Ask the server owner to connect it in Server settings → Live.
      </p>
    </template>
    <template #footer>
      <UButton color="neutral" variant="ghost" label="Close" @click="ui.liveSetupOpen = false" />
      <UButton v-if="isOwner" icon="i-ph-plugs-connected" label="Connect Live" @click="openSettings" />
    </template>
  </UModal>
</template>

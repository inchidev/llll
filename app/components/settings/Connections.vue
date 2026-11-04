<script setup lang="ts">
import type { ConnectionsTab } from '~/utils/settings-sections'

const props = defineProps<{ serverId: string; isOwner: boolean; initialTab?: ConnectionsTab }>()
const tabs = computed(() => [
  { label: 'Shortcut', value: 'shortcut' as const },
  { label: 'Apps', value: 'apps' as const },
  ...(props.isOwner ? [{ label: 'Tokens', value: 'tokens' as const }] : []),
])
const tab = ref<ConnectionsTab>(props.initialTab ?? 'apps')
</script>

<template>
  <div>
    <h1 class="text-xl font-semibold text-highlighted">Connections</h1>
    <LayoutSegmentedTabs v-model="tab" :items="tabs" label="Connections" class="mt-4" />
    <div class="pt-4">
      <SettingsConnectShortcut v-if="tab === 'shortcut'" />
      <div v-else-if="tab === 'apps'" class="space-y-6"><SettingsConnectApp /><SettingsMcpConnections /></div>
      <SettingsMcpSettings v-else :server-id="serverId" />
    </div>
  </div>
</template>

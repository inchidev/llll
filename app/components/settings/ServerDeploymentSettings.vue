<script setup lang="ts">
/**
 * Where the server runs (the owner's Cloudflare account), as one "System"
 * nav entry with sub-tabs. Each tab keeps its own section id, so deep links like
 * `?section=backups` still land on the right tab.
 */
const props = defineProps<{
  serverId: string
  serverName: string
  updatesBehind?: number
}>()

const section = defineModel<string>('section', { required: true })

const tabs = computed(() => [
  { value: 'cloudflare', label: 'Overview' },
  { value: 'domains', label: 'Domain' },
  { value: 'backups', label: 'Backups' },
  { value: 'updates', label: 'Updates', count: props.updatesBehind || undefined },
  { value: 'danger', label: 'Remove' },
])
</script>

<template>
  <div>
    <LayoutSegmentedTabs v-model="section" :items="tabs" label="Server deployment settings" class="mb-8" />
    <SettingsCloudflareSettings
      v-if="section === 'cloudflare' || section === 'domains'"
      :server-id="serverId"
      :view="section === 'domains' ? 'domains' : 'overview'"
      @navigate="section = $event"
    />
    <SettingsBackupSettings v-else-if="section === 'backups'" :server-id="serverId" />
    <SettingsUpdateSettings v-else-if="section === 'updates'" :server-id="serverId" />
    <SettingsDangerZoneSettings
      v-else-if="section === 'danger'"
      :server-id="serverId"
      :server-name="serverName"
      @backups="section = 'backups'"
    />
  </div>
</template>

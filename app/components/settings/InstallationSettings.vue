<script setup lang="ts">
/**
 * Where the workspace runs (the owner's Cloudflare account), as one "System"
 * nav entry with sub-tabs. Each tab keeps its own section id, so deep links like
 * `?section=backups` still land on the right tab.
 */
const props = defineProps<{
  workspaceId: string
  workspaceName: string
  updatesBehind?: number
}>()

const section = defineModel<string>('section', { required: true })

const tabs = computed(() => [
  { value: 'cloudflare', label: 'Overview' },
  { value: 'domains', label: 'Domain' },
  { value: 'backups', label: 'Backups' },
  { value: 'updates', label: 'Updates', count: props.updatesBehind || undefined },
  { value: 'telemetry', label: 'Telemetry' },
  { value: 'danger', label: 'Delete' },
])
</script>

<template>
  <div>
    <LayoutSegmentedTabs v-model="section" :items="tabs" label="System settings" class="mb-8" />
    <SettingsCloudflareSettings
      v-if="section === 'cloudflare' || section === 'domains'"
      :workspace-id="workspaceId"
      :view="section === 'domains' ? 'domains' : 'overview'"
      @navigate="section = $event"
    />
    <SettingsBackupSettings v-else-if="section === 'backups'" :workspace-id="workspaceId" />
    <SettingsUpdateSettings v-else-if="section === 'updates'" :workspace-id="workspaceId" />
    <SettingsTelemetrySettings v-else-if="section === 'telemetry'" :workspace-id="workspaceId" />
    <SettingsDangerZoneSettings
      v-else-if="section === 'danger'"
      :workspace-id="workspaceId"
      :workspace-name="workspaceName"
      @backups="section = 'backups'"
    />
  </div>
</template>

<script setup lang="ts">
import type { RightPanelTab } from '~~/shared/types'

const model = defineModel<RightPanelTab>({ required: true })

const tabs: Array<{ value: RightPanelTab; label: string }> = [
  { value: 'members', label: 'Members' },
  { value: 'threads', label: 'Threads' },
  { value: 'pins', label: 'Pins' },
  { value: 'files', label: 'Files' },
]
</script>

<template>
  <LayoutSegmentedTabs v-model="model" :items="tabs" label="Right panel views" block class="w-full" />
</template>

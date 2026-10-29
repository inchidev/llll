<script setup lang="ts">
import { agentModelInputs, type AgentModelInput } from '~~/shared/agent-providers'
const props = defineProps<{ inputs?: AgentModelInput[]; tools?: boolean; reasoning?: boolean }>()
const inputIcons: Record<AgentModelInput, { icon: string; label: string }> = {
  text: { icon: 'i-ph-text-aa', label: 'Reads text' },
  image: { icon: 'i-ph-image', label: 'Sees images' },
  audio: { icon: 'i-ph-waveform', label: 'Hears audio' },
  video: { icon: 'i-ph-video-camera', label: 'Watches video' },
  file: { icon: 'i-ph-file-text', label: 'Reads files' },
}
// Unknown capability shows nothing rather than guessing.
const items = computed(() => [
  ...agentModelInputs.filter(input => props.inputs?.includes(input)).map(input => inputIcons[input]),
  ...(props.reasoning ? [{ icon: 'i-ph-brain', label: 'Reasoning effort' }] : []),
  ...(props.tools === false ? [{ icon: 'i-ph-wrench', label: 'No tools: AI functions only' }] : []),
])
</script>

<template>
  <span v-if="items.length" class="inline-flex shrink-0 items-center gap-1 text-muted">
    <UTooltip v-for="item in items" :key="item.icon" :text="item.label">
      <UIcon :name="item.icon" class="size-3.5" :class="item.icon === 'i-ph-wrench' ? 'text-warning' : ''" :aria-label="item.label" />
    </UTooltip>
  </span>
</template>

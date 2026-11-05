<script setup lang="ts">
import type { IntegrationFieldStatus } from '~~/shared/integrations'

const props = defineProps<{ label: string; status?: IntegrationFieldStatus; placeholder?: string; plain?: boolean; busy?: boolean }>()
defineEmits<{ remove: [] }>()
const value = defineModel<string>()
const fromDeployment = computed(() => props.status?.source === 'deployment')
const hint = computed(() => props.status?.value ?? (props.status?.source === 'settings' ? 'Saved (hidden). Enter a new value to replace it.' : props.placeholder))
</script>

<template>
  <UFormField :label="label">
    <div class="flex min-w-0 items-center gap-2">
      <UInput v-if="!fromDeployment" v-model="value" :type="plain ? 'text' : 'password'" autocomplete="off" :aria-label="label" :placeholder="hint" class="min-w-0 flex-1" />
      <span v-else class="min-w-0 flex-1 break-all text-sm text-muted">{{ status?.value ?? 'Set' }}</span>
      <UBadge v-if="fromDeployment" label="Set by the deployment" color="neutral" variant="subtle" />
      <UButton v-else-if="status?.source === 'settings'" label="Remove" color="neutral" variant="ghost" :loading="busy" @click="$emit('remove')" />
    </div>
  </UFormField>
</template>

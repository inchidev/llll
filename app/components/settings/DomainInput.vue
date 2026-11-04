<script setup lang="ts">
/**
 * One field for a hostname inside a Cloudflare zone: `[label] . [zone ▾]`.
 * The preview under it shows exactly what will be connected.
 */
const props = withDefaults(defineProps<{
  zones: Array<{ id: string, name: string }>
  placeholder?: string
  /** Allow an empty label, meaning the zone itself. */
  allowApex?: boolean
  /** Turns the resolved hostname into the example shown under the field. */
  example?: (hostname: string) => string
}>(), {
  placeholder: 'mail',
  allowApex: false,
  example: undefined,
})

const label = defineModel<string>('label', { default: '' })
const zoneId = defineModel<string>('zoneId', { default: '' })

const zoneOptions = computed(() => props.zones.map(zone => ({ label: zone.name, value: zone.id })))
const zoneName = computed(() => props.zones.find(zone => zone.id === zoneId.value)?.name || '')
const hostname = computed(() => {
  const value = label.value.trim().toLowerCase()
  if (!zoneName.value) return ''
  if (!value) return props.allowApex ? zoneName.value : ''
  return `${value}.${zoneName.value}`
})

defineExpose({ hostname })
</script>

<template>
  <div>
    <div class="flex min-w-0 items-center gap-1.5">
      <UInput v-model="label" :placeholder="placeholder" class="min-w-0 flex-1" aria-label="Subdomain" autocomplete="off" autofocus />
      <span class="text-muted">.</span>
      <USelect v-model="zoneId" :items="zoneOptions" value-key="value" class="min-w-0 flex-1" aria-label="Domain" />
    </div>
    <p class="mt-1.5 min-h-5 text-xs text-muted">
      <template v-if="hostname">
        {{ example ? example(hostname) : hostname }}
      </template>
      <template v-else-if="!zones.length">
        No active domains in your Cloudflare account yet.
      </template>
    </p>
    <p v-if="allowApex && zoneName" class="text-xs text-dimmed">
      Leave the first part empty to use {{ zoneName }} itself.
    </p>
  </div>
</template>

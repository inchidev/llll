<script setup lang="ts">
import { resolveModelLimits, type AgentModelLimitSource } from '~~/shared/agent-model-limits'
type Limits = { contextWindow?: number; maxOutputTokens?: number }
/**
 * The context window and answer limit a Run will use for one model, with where each comes from. Where the provider
 * reported none, the Owner may set it; what the provider reported is never overridden here.
 */
const props = defineProps<{ reported?: Limits; catalog?: Limits; editable?: boolean; label?: string }>()
const owner = defineModel<Limits | undefined>()
const used = computed(() => resolveModelLimits({ reported: props.reported, owner: owner.value, catalog: props.catalog }))
const sourceLabels: Record<AgentModelLimitSource, string> = { reported: 'reported by the provider', owner: 'set by you', catalog: 'from Pi’s catalog', default: 'default' }
const open = ref(false)
const settable = computed(() => ({ contextWindow: !props.reported?.contextWindow, maxOutputTokens: !props.reported?.maxOutputTokens }))
const number = (value: number) => value.toLocaleString()
function set(key: keyof Limits, value: string | number) {
  const parsed = Number(value)
  const next: Limits = { ...owner.value, [key]: value === '' || !Number.isFinite(parsed) || parsed <= 0 ? undefined : Math.floor(parsed) }
  const kept = Object.fromEntries(Object.entries(next).filter(([, limit]) => limit !== undefined)) as Limits
  owner.value = kept.contextWindow || kept.maxOutputTokens ? kept : undefined
}
</script>

<template>
  <div class="text-xs text-muted" data-model-limits>
    <p>
      Window {{ number(used.contextWindow) }} tokens, {{ sourceLabels[used.sources.contextWindow] }} · Answer {{ number(used.maxOutputTokens) }}, {{ sourceLabels[used.sources.maxOutputTokens] }}
      <UButton v-if="editable && (settable.contextWindow || settable.maxOutputTokens)" :label="open ? 'Done' : 'Set limits'" size="xs" color="neutral" variant="link" class="p-0 align-baseline" @click="open = !open" />
    </p>
    <div v-if="open" class="mt-2 grid gap-2 sm:grid-cols-2">
      <UFormField v-if="settable.contextWindow" :label="`${label ?? 'Model'}: context window`" help="Tokens. A Run uses at most 200,000.">
        <UInput type="number" :min="1024" :model-value="owner?.contextWindow" :placeholder="String(resolveModelLimits({ catalog }).contextWindow)" class="w-full" @update:model-value="value => set('contextWindow', value)" />
      </UFormField>
      <UFormField v-if="settable.maxOutputTokens" :label="`${label ?? 'Model'}: answer limit`" help="Tokens. A Run uses at most 32,000 and a quarter of the window.">
        <UInput type="number" :min="1024" :model-value="owner?.maxOutputTokens" :placeholder="String(resolveModelLimits({ catalog }).maxOutputTokens)" class="w-full" @update:model-value="value => set('maxOutputTokens', value)" />
      </UFormField>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { DropdownMenuItem } from '@nuxt/ui'
import { spaceInitials, spacesWaiting } from '../../utils/spaces'

const props = defineProps<{ serverId: string }>()
const { api } = useApi()
const nav = useNavActions()
const { spaces, activeSpace, canSwitch, switchTo } = useSpaces(() => props.serverId)
const label = computed(() => activeSpace.value?.name || 'Spaces')
const initials = computed(() => spaceInitials(activeSpace.value?.name))
// The Inbox shows the active Space; this says, and only says, that another of yours has something new.
const attentionQ = useQuery({
  queryKey: computed(() => ['space-attention', props.serverId]),
  queryFn: () => api<{ spaceIds: string[] }>(`/api/servers/${props.serverId}/spaces/attention`),
  enabled: canSwitch,
  refetchInterval: 30_000,
})
const waiting = computed(() => spacesWaiting(attentionQ.data.value?.spaceIds, activeSpace.value?.id))
const items = computed<DropdownMenuItem[][]>(() => [spaces.value.map(space => space.role
  ? { label: space.name, type: 'checkbox' as const, checked: space.id === activeSpace.value?.id, unread: waiting.value.has(space.id), onSelect: () => switchTo(space.id) }
  // An Owner reaches a Space only by joining it, which is a recorded step in settings.
  : { label: `${space.name} (not joined)`, icon: 'i-ph-lock-simple', onSelect: () => { nextTick(() => nav.openServerSettings('spaces')) } })])
</script>

<template>
  <div v-if="canSwitch" class="shrink-0 border-b border-default px-1.5 pb-2 pt-1">
    <UDropdownMenu :items="items" :ui="{ content: 'w-56' }">
      <button
        type="button"
        class="relative flex w-full flex-col items-center gap-1 rounded-xl border border-default bg-default px-1 py-1.5 shadow-xs hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary data-[state=open]:bg-accented"
        :aria-label="`Space: ${label}. Switch Space${waiting.size ? '. New in another Space' : ''}`"
        :title="label"
      >
        <span class="flex items-center gap-0.5">
          <span class="flex size-7 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-inverted" aria-hidden="true">{{ initials }}</span>
          <UIcon name="i-ph-caret-up-down" class="size-3 shrink-0 text-muted" />
        </span>
        <span class="w-full min-w-0 truncate text-center text-[11px] font-semibold leading-3 text-highlighted">{{ label }}</span>
        <span v-if="waiting.size" class="absolute end-1 top-1 size-2.5 rounded-full bg-primary ring-2 ring-[var(--ui-bg)]" data-space-unread aria-hidden="true" />
      </button>
      <template #item-label="{ item }">
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="min-w-0 truncate">{{ item.label }}</span>
          <span v-if="item.unread" class="size-2 shrink-0 rounded-full bg-primary" role="img" aria-label="New" data-space-unread-item />
        </span>
      </template>
    </UDropdownMenu>
  </div>
</template>

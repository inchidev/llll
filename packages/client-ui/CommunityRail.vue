<script setup lang="ts">
import { computed } from 'vue'
import { UDropdownMenu, UIcon, UTooltip } from '#components'

interface RailGroup {
  origin: string
  name: string
  collapsed?: boolean
  servers: { id: string; name: string; unread?: number }[]
}
const props = defineProps<{ groups: RailGroup[]; activeOrigin?: string; activeServerId?: string }>()
const emit = defineEmits<{
  connect: []
  connections: []
  install: []
  group: [origin: string]
  toggle: [origin: string]
  server: [origin: string, id: string]
}>()
const menu = [
  { label: 'Your connections', icon: 'i-ph-plugs-connected', onSelect: () => emit('connections') },
  { label: 'Install your own L4', icon: 'i-ph-cloud-arrow-up', onSelect: () => emit('install') },
]
const visibleGroups = computed(() => props.groups.filter(group => group.servers.length))
function groupMenu(group: RailGroup) {
  return [
    { label: group.name, type: 'label' as const },
    { label: 'Open connection', icon: 'i-ph-plugs-connected', onSelect: () => emit('group', group.origin) },
    { label: group.collapsed ? 'Show servers' : 'Hide servers', icon: 'i-ph-list', onSelect: () => emit('toggle', group.origin) },
  ]
}
function initials(name: string) {
  return name.trim().split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase()
}
</script>

<template>
  <nav aria-label="Instances and servers" class="community-rail flex h-full w-[72px] shrink-0 flex-col items-center gap-3 overflow-y-auto border-e border-default bg-elevated px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]">
    <UDropdownMenu :items="menu" :content="{ side: 'right', align: 'start' }">
      <button aria-label="L4 menu" title="L4 menu" class="flex size-11 shrink-0 items-center justify-center rounded-2xl text-highlighted hover:bg-accented focus-visible:outline-2 focus-visible:outline-primary">
        <svg class="size-7" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M2 2h4v8h8v4H2V2Zm16 0h4v8h8v4H18V2ZM2 18h4v8h8v4H2V18Zm16 0h4v8h8v4H18V18Z" /></svg>
      </button>
    </UDropdownMenu>
    <section v-for="group in visibleGroups" :key="group.origin" :aria-label="group.name" class="flex w-full shrink-0 flex-col items-center gap-2">
      <UDropdownMenu :items="groupMenu(group)" :content="{ side: 'right', align: 'start' }">
        <button :aria-label="`Manage ${group.name}`" :title="group.name" class="flex h-6 w-11 items-center justify-center rounded-md text-muted hover:bg-accented hover:text-highlighted"><UIcon name="i-ph-dots-three" class="size-5" /></button>
      </UDropdownMenu>
      <template v-if="!group.collapsed">
        <UTooltip v-for="server in group.servers" :key="server.id" :text="`${server.name} · ${group.name}`" :content="{ side: 'right' }">
          <button :aria-label="`${server.name} on ${group.name}`" :aria-current="activeOrigin === group.origin && activeServerId === server.id ? 'page' : undefined" class="relative flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accented text-sm font-semibold text-default transition hover:rounded-xl hover:bg-inverted hover:text-inverted focus-visible:outline-2 focus-visible:outline-primary" :class="activeOrigin === group.origin && activeServerId === server.id ? 'rounded-xl ring-2 ring-primary' : ''" @click="emit('server', group.origin, server.id)">
            {{ initials(server.name) }}
            <span v-if="server.unread" class="absolute -bottom-1 -right-1 rounded bg-primary px-1 text-[10px] text-inverted">{{ server.unread }}</span>
          </button>
        </UTooltip>
      </template>
    </section>
    <UTooltip text="Connect an instance" :content="{ side: 'right' }">
      <button aria-label="Connect an instance" class="flex size-11 shrink-0 items-center justify-center rounded-2xl text-muted hover:bg-accented hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary" @click="emit('connect')"><UIcon name="i-ph-plus" class="size-5" /></button>
    </UTooltip>
  </nav>
</template>

<style scoped>
/* Both hosts have their own page theme. Keep navigation consistent in either. */
.community-rail {
  font-family: Geist, ui-sans-serif, system-ui, sans-serif;
  --ui-bg-elevated: #ffffff;
  --ui-bg-accented: #f5f5f5;
  --ui-bg-inverted: #171717;
  --ui-text: #171717;
  --ui-text-muted: #525252;
  --ui-text-highlighted: #000000;
  --ui-text-inverted: #fafafa;
  --ui-border: #e5e5e5;
}
:global(.dark) .community-rail {
  --ui-bg-elevated: #0a0a0a;
  --ui-bg-accented: #171717;
  --ui-bg-inverted: #fafafa;
  --ui-text: #e5e5e5;
  --ui-text-muted: #a3a3a3;
  --ui-text-highlighted: #fafafa;
  --ui-text-inverted: #0a0a0a;
  --ui-border: #262626;
}
</style>

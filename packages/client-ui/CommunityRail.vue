<script setup lang="ts">
import { computed } from 'vue'
import { UIcon, UTooltip } from '#components'
import ServerAvatar from './ServerAvatar.vue'

interface RailGroup {
  origin: string
  name: string
  collapsed?: boolean
  servers: { id: string; name: string; unread?: number; iconUrl?: string | null }[]
}
const props = defineProps<{ groups: RailGroup[]; activeOrigin?: string; activeServerId?: string; addActive?: boolean; homeHref?: string; homeLabel?: string; homeActive?: boolean }>()
const emit = defineEmits<{
  home: [event: MouseEvent]
  connect: []
  group: [origin: string]
  toggle: [origin: string]
  server: [origin: string, id: string]
}>()
const visibleGroups = computed(() => props.groups.filter(group => group.servers.length))
</script>

<template>
  <nav aria-label="Servers" class="community-rail flex h-full w-[72px] shrink-0 flex-col items-center gap-3 overflow-y-auto border-e border-default bg-elevated px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.125rem,env(safe-area-inset-top))]">
    <a :href="homeHref || '/'" :aria-label="homeLabel || 'L4 home'" :aria-current="homeActive ? 'page' : undefined" :class="homeActive ? 'bg-accented ring-2 ring-primary' : ''" class="flex size-11 shrink-0 items-center justify-center rounded-2xl text-highlighted hover:bg-accented focus-visible:outline-2 focus-visible:outline-primary" @click="emit('home', $event)">
        <svg class="size-7" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M2 2h4v8h8v4H2V2Zm16 0h4v8h8v4H18V2ZM2 18h4v8h8v4H2V18Zm16 0h4v8h8v4H18V18Z" /></svg>
    </a>
    <section v-for="group in visibleGroups" :key="group.origin" :aria-label="group.name" class="flex w-full shrink-0 flex-col items-center gap-2">
      <template v-if="!group.collapsed">
        <UTooltip v-for="server in group.servers" :key="server.id" :text="server.name" :content="{ side: 'right' }">
          <button :aria-label="server.name" :aria-current="activeOrigin === group.origin && activeServerId === server.id ? 'page' : undefined" class="relative flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accented text-sm font-semibold text-default transition hover:rounded-xl hover:bg-inverted hover:text-inverted focus-visible:outline-2 focus-visible:outline-primary" :class="activeOrigin === group.origin && activeServerId === server.id ? 'rounded-xl ring-2 ring-primary' : ''" @click="emit('server', group.origin, server.id)">
            <ServerAvatar :name="server.name" :icon-url="server.iconUrl" class="size-full rounded-[inherit]" />
            <span v-if="server.unread" class="absolute -bottom-1 -right-1 rounded bg-primary px-1 text-[10px] text-inverted">{{ server.unread }}</span>
          </button>
        </UTooltip>
      </template>
    </section>
    <UTooltip text="Add a Server" :content="{ side: 'right' }">
      <button aria-label="Add a Server" :aria-current="addActive ? 'page' : undefined" :class="addActive ? 'bg-accented text-highlighted ring-2 ring-primary' : 'text-muted'" class="flex size-11 shrink-0 items-center justify-center rounded-2xl hover:bg-accented hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary" @click="emit('connect')"><UIcon name="i-ph-plus" class="size-5" /></button>
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
.dark .community-rail {
  --ui-bg-elevated: #000000;
  --ui-bg-accented: #171717;
  --ui-bg-inverted: #fafafa;
  --ui-text: #e5e5e5;
  --ui-text-muted: #a3a3a3;
  --ui-text-highlighted: #fafafa;
  --ui-text-inverted: #0a0a0a;
  --ui-border: #262626;
}
@media (forced-colors: active) {
  .community-rail :deep(.iconify) { forced-color-adjust: none; color: ButtonText; }
}
</style>

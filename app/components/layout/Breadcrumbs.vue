<script setup lang="ts">
import { breadcrumbTrail, type Breadcrumb } from '../../utils/spaces'

/**
 * Where this page sits: Space / Project / board / Task. The Space shows only to someone with more
 * than one. A phone keeps the last two, stacked, so a repeated board name still has its Project.
 */
const props = defineProps<{
  items: Breadcrumb[]
  /** The page's own name is the next thing in the bar, such as a title you can edit. */
  leadsIn?: boolean
}>()
const { serverId } = useServer()
const { activeSpace, canSwitch } = useSpaces(() => serverId.value || '')
const crumbs = computed(() => breadcrumbTrail(canSwitch.value ? activeSpace.value?.name : null, props.items))
const isPage = (index: number) => !props.leadsIn && index === crumbs.value.length - 1
</script>

<template>
  <nav aria-label="Breadcrumb" class="min-w-0" :class="leadsIn ? 'hidden shrink-0 md:block' : 'flex-1'">
    <ol class="flex min-w-0 flex-col justify-center md:flex-row md:items-center md:justify-start md:gap-1">
      <li
        v-for="(crumb, index) in crumbs"
        :key="index"
        class="min-w-0 items-center gap-1"
        :class="index < crumbs.length - 2 ? 'hidden md:flex' : 'flex'"
      >
        <span v-if="index" class="hidden shrink-0 text-sm text-dimmed md:inline" aria-hidden="true">/</span>
        <h1 v-if="isPage(index)" class="min-w-0 truncate text-[15px] font-semibold text-highlighted" aria-current="page">{{ crumb.label }}</h1>
        <NuxtLink v-else-if="crumb.to" :to="crumb.to" class="min-w-0 truncate text-[11px] leading-3 text-muted hover:text-default md:text-sm md:leading-normal">{{ crumb.label }}</NuxtLink>
        <span v-else class="min-w-0 truncate text-[11px] leading-3 text-muted md:text-sm md:leading-normal">{{ crumb.label }}</span>
        <span v-if="leadsIn && index === crumbs.length - 1" class="ms-1 shrink-0 text-sm text-dimmed" aria-hidden="true">/</span>
      </li>
    </ol>
  </nav>
</template>

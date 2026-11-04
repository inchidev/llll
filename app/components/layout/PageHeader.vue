<script setup lang="ts">
/**
 * The 48px bar at the top of every server page. On phones it carries the
 * button that opens the navigation drawer, so no page is a dead end.
 */
defineProps<{
  title?: string
  /** The page's place under its Space, instead of a plain title. */
  crumbs?: { label: string; to?: string }[]
  icon?: string
  loading?: boolean
}>()
</script>

<template>
  <header class="df-top-row z-10 flex shrink-0 items-center gap-2 bg-default px-3 shadow-[0_1px_0_var(--ui-border)] md:px-4">
    <LayoutMobileMenuButton />
    <slot name="leading">
      <UIcon v-if="icon" :name="icon" class="size-5 shrink-0 text-muted" :class="{ 'hidden md:block': crumbs }" />
    </slot>
    <slot name="title">
      <USkeleton v-if="loading" class="h-4 w-28" />
      <LayoutBreadcrumbs v-else-if="crumbs" :items="crumbs" />
      <h1 v-else class="min-w-0 truncate text-[15px] font-semibold text-highlighted">{{ title }}</h1>
    </slot>
    <slot name="meta" />
    <div v-if="$slots.actions" class="ms-auto flex min-w-0 shrink-0 items-center gap-1">
      <slot name="actions" />
    </div>
  </header>
</template>

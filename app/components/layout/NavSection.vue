<script setup lang="ts">
const props = defineProps<{
  label: string
  /** Persists the open/closed state across navigation and reloads. */
  collapseKey: string
  /** Shown on the `+` button; omit the button entirely when absent. */
  createLabel?: string
  /** Draws the indent guide rail around the section body. */
  rail?: boolean
}>()

defineEmits<{ create: [] }>()

const ui = useUiStore()
const collapsed = computed({
  get: () => ui.isCollapsed(props.collapseKey),
  set: value => ui.setCollapsed(props.collapseKey, value),
})
</script>

<template>
  <section>
    <div class="flex min-h-11 items-center pr-2 md:min-h-6">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1 pl-3 pr-1 text-xs font-semibold text-muted hover:text-default"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        <span class="truncate text-start">{{ label }}</span>
        <UIcon :name="collapsed ? 'i-ph-caret-right' : 'i-ph-caret-down'" class="size-3 shrink-0" />
      </button>
      <UButton
        v-if="createLabel"
        icon="i-ph-plus"
        color="neutral"
        variant="ghost"
        size="xs"
        square
        class="size-11 md:size-7"
        :aria-label="createLabel"
        @click="$emit('create')"
      />
    </div>
    <div v-show="!collapsed" :class="rail ? 'ms-4 border-s border-default ps-2' : 'px-2'">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts" generic="T extends string">
/**
 * The one tab style in the app: a muted track with the active item raised,
 * matching the app switcher in the navigation.
 */
const model = defineModel<T>({ required: true })

const props = withDefaults(defineProps<{
  items: ReadonlyArray<{ value: T, label: string, icon?: string, count?: number }>
  label: string
  size?: 'sm' | 'md'
  block?: boolean
}>(), {
  size: 'sm',
  block: false,
})

const buttons = ref<HTMLButtonElement[]>([])

function focusAt(index: number) {
  const count = props.items.length
  const next = props.items[(index + count) % count]
  if (!next) return
  model.value = next.value
  nextTick(() => buttons.value[(index + count) % count]?.focus())
}

function onKeydown(event: KeyboardEvent, index: number) {
  if (event.key === 'ArrowRight') focusAt(index + 1)
  else if (event.key === 'ArrowLeft') focusAt(index - 1)
  else if (event.key === 'Home') focusAt(0)
  else if (event.key === 'End') focusAt(props.items.length - 1)
  else return
  event.preventDefault()
}
</script>

<template>
  <div
    role="tablist"
    :aria-label="label"
    class="min-w-0 gap-0.5 rounded-lg bg-elevated/60 p-0.5"
    :class="block ? 'grid' : 'inline-flex max-w-full overflow-x-auto'"
    :style="block ? { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` } : undefined"
    data-no-drawer-swipe
  >
    <button
      v-for="(item, index) in items"
      :key="item.value"
      ref="buttons"
      type="button"
      role="tab"
      :aria-selected="model === item.value"
      :tabindex="model === item.value ? 0 : -1"
      class="flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary"
      :class="[
        size === 'md' ? 'h-9 px-3 text-sm' : 'h-8 px-2.5 text-xs md:h-7',
        model === item.value ? 'bg-default text-highlighted shadow-sm' : 'text-muted hover:text-default',
      ]"
      @click="model = item.value"
      @keydown="onKeydown($event, index)"
    >
      <UIcon v-if="item.icon" :name="item.icon" class="size-4 shrink-0" />
      <span>{{ item.label }}</span>
      <span v-if="item.count !== undefined" class="tabular-nums text-dimmed">{{ item.count }}</span>
    </button>
  </div>
</template>

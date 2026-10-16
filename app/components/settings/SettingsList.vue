<script setup lang="ts" generic="T">
/**
 * Searchable list for settings collections (roles, mailboxes, …). It stays
 * usable at any size: search narrows it, and rows are compact and scannable.
 */
const props = withDefaults(defineProps<{
  items: T[]
  itemKey: (item: T) => string
  searchText: (item: T) => string
  placeholder?: string
  noun?: [string, string]
  loading?: boolean
  /** Show the search box once the list is at least this long. */
  searchFrom?: number
}>(), {
  placeholder: 'Search',
  noun: () => ['item', 'items'],
  loading: false,
  searchFrom: 6,
})
defineEmits<{ select: [item: T] }>()

const query = ref('')
const filtered = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  if (!term) return props.items
  return props.items.filter(item => props.searchText(item).toLocaleLowerCase().includes(term))
})
const countLabel = computed(() => {
  const total = props.items.length
  const shown = filtered.value.length
  const noun = total === 1 ? props.noun[0] : props.noun[1]
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`
})
</script>

<template>
  <div>
    <div v-if="!loading && items.length >= searchFrom" class="mb-3 flex items-center gap-3">
      <UInput v-model="query" icon="i-ph-magnifying-glass" :placeholder="placeholder" :aria-label="placeholder" class="min-w-0 flex-1" />
      <span class="shrink-0 text-xs text-muted tabular-nums">{{ countLabel }}</span>
    </div>
    <LayoutSkeleton v-if="loading" variant="rows" :rows="4" class="-mx-2" />
    <slot v-else-if="!items.length" name="empty" />
    <p v-else-if="!filtered.length" class="rounded-lg border border-dashed border-default px-4 py-6 text-center text-sm text-muted">
      Nothing matches “{{ query }}”.
    </p>
    <ul v-else class="divide-y divide-default overflow-hidden rounded-lg border border-default">
      <li v-for="item in filtered" :key="itemKey(item)">
        <button
          type="button"
          class="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-elevated/60 focus-visible:bg-elevated/60 focus-visible:outline-none"
          @click="$emit('select', item)"
        >
          <slot name="row" :item="item" />
          <UIcon name="i-ph-caret-right" class="size-4 shrink-0 text-dimmed" />
        </button>
      </li>
    </ul>
  </div>
</template>

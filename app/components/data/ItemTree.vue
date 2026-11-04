<script setup lang="ts">
import type { DataItemSummary } from '~~/shared/data-items'
import { itemPath } from '~~/shared/data-items'
const props = withDefaults(defineProps<{ items: DataItemSummary[]; parentId?: string | null }>(), { parentId: null })
const route = useRoute()
const expanded = ref(new Set<string>())
const children = computed(() =>
  props.items.filter((item) => item.parentId === props.parentId && (props.parentId !== null || !item.databaseId)),
)
function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}
</script>
<template>
  <ul>
    <li v-for="item in children" :key="item.id">
      <div class="flex items-center">
        <UButton
          v-if="items.some((child) => child.parentId === item.id)"
          :icon="expanded.has(item.id) ? 'i-ph-caret-down' : 'i-ph-caret-right'"
          :aria-label="`Expand ${item.title}`"
          :aria-expanded="expanded.has(item.id)"
          size="xs"
          variant="ghost"
          color="neutral"
          @click="toggle(item.id)"
        />
        <LayoutNavRow
          :to="itemPath(item.id)"
          :title="item.title"
          :active="route.path === itemPath(item.id)"
          class="min-w-0 flex-1"
          ><template #leading
            ><span v-if="item.icon">{{ item.icon }}</span
            ><UIcon
              v-else
              :name="item.kind === 'canvas' ? 'i-ph-selection-background' : 'i-ph-file-text'"
              class="size-4" /></template
          >{{ item.title }}</LayoutNavRow
        >
      </div>
      <DataItemTree
        v-if="expanded.has(item.id)"
        :items="items"
        :parent-id="item.id"
        class="ms-4 border-s border-default ps-1"
      />
    </li>
  </ul>
</template>

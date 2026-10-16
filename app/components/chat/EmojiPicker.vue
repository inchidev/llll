<script setup lang="ts">
import { emojiCategories, searchEmoji, type EmojiEntry } from '~~/shared/emoji'

const emit = defineEmits<{ select: [emoji: string] }>()

const prefs = usePrefsStore()
const query = ref('')
const hovered = ref<EmojiEntry | null>(null)
const grid = ref<HTMLElement | null>(null)
const categories = emojiCategories()
const byEmoji = new Map(categories.flatMap(category => category.emoji).map(entry => [entry.emoji, entry]))
const DEFAULT_RECENT = ['👍', '❤️', '😂', '🎉', '👀', '🔥', '✅', '🙏']

const recent = computed(() => {
  const list = Array.isArray(prefs.recentEmoji) && prefs.recentEmoji.length ? prefs.recentEmoji : DEFAULT_RECENT
  return list.map(emoji => byEmoji.get(emoji) ?? { emoji, name: '', keywords: [], category: 'recent' })
})
const results = computed(() => searchEmoji(query.value, 80))
const sections = computed(() => query.value.trim()
  ? [{ id: 'results', label: results.value.length ? 'Results' : 'No emoji found', emoji: results.value }]
  : [{ id: 'recent', label: 'Frequently used', emoji: recent.value }, ...categories])

function pick(entry: EmojiEntry) {
  prefs.useEmoji(entry.emoji)
  emit('select', entry.emoji)
}

function jump(id: string) {
  query.value = ''
  nextTick(() => grid.value?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ block: 'start' }))
}

function onSearchKey(event: KeyboardEvent) {
  const first = results.value[0]
  if (event.key === 'Enter' && first) {
    event.preventDefault()
    pick(first)
  }
}
</script>

<template>
  <div class="flex h-[22rem] w-[min(21rem,calc(100vw-2rem))] flex-col">
    <div class="p-2 pb-1">
      <UInput
        v-model="query"
        icon="i-ph-magnifying-glass"
        size="sm"
        placeholder="Find the perfect emoji"
        class="w-full"
        autofocus
        aria-label="Search emoji"
        @keydown="onSearchKey"
      />
    </div>
    <nav class="flex gap-0.5 border-b border-default px-2 pb-1" aria-label="Emoji categories">
      <UTooltip v-for="category in [{ id: 'recent', label: 'Frequently used', icon: 'i-ph-clock-counter-clockwise' }, ...categories]" :key="category.id" :text="category.label">
        <UButton
          :icon="category.icon"
          size="xs"
          color="neutral"
          variant="ghost"
          square
          :aria-label="category.label"
          @click="jump(category.id)"
        />
      </UTooltip>
    </nav>
    <div ref="grid" class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <section v-for="section in sections" :key="section.id" :data-section="section.id">
        <h3 class="sticky top-0 z-10 bg-default/95 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted backdrop-blur">
          {{ section.label }}
        </h3>
        <div class="grid grid-cols-8 gap-0.5">
          <button
            v-for="entry in section.emoji"
            :key="`${section.id}-${entry.emoji}`"
            type="button"
            class="flex aspect-square items-center justify-center rounded-md text-[22px] leading-none hover:bg-elevated focus-visible:bg-elevated focus-visible:outline-none"
            :aria-label="entry.name ? `:${entry.name}:` : entry.emoji"
            @mouseenter="hovered = entry"
            @focus="hovered = entry"
            @click="pick(entry)"
          >
            {{ entry.emoji }}
          </button>
        </div>
      </section>
    </div>
    <footer class="flex h-10 shrink-0 items-center gap-2 border-t border-default bg-elevated/50 px-3 text-sm">
      <template v-if="hovered">
        <span class="text-xl leading-none">{{ hovered.emoji }}</span>
        <span v-if="hovered.name" class="truncate font-medium text-toned">:{{ hovered.name }}:</span>
      </template>
      <span v-else class="text-xs text-muted">Tip: type <kbd class="font-mono">:name</kbd> in a message</span>
    </footer>
  </div>
</template>

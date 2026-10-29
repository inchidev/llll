<script setup lang="ts">
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'

// Search over /docs/search.json, a prerendered index of page titles,
// descriptions and headings. It loads the first time the palette opens.
interface SearchEntry { title: string, description: string, url: string, section: string, headings: { id: string, text: string }[] }

const open = ref(false)
const entries = ref<SearchEntry[] | null>(null)
const loading = ref(false)

async function load() {
  if (entries.value || loading.value) return
  loading.value = true
  try { entries.value = await $fetch<SearchEntry[]>('/docs/search.json') }
  catch { entries.value = [] }
  finally { loading.value = false }
}
watch(open, value => { if (value) load() })
defineShortcuts({ meta_k: () => { open.value = !open.value } })

const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() => {
  const sections = new Map<string, CommandPaletteItem[]>()
  for (const entry of entries.value || []) {
    const items = sections.get(entry.section) || []
    items.push({ label: entry.title, suffix: entry.description, to: entry.url, icon: 'i-ph-file-text', onSelect: () => { open.value = false } })
    for (const heading of entry.headings) items.push({ label: heading.text, suffix: entry.title, to: `${entry.url}#${heading.id}`, icon: 'i-ph-hash', onSelect: () => { open.value = false } })
    sections.set(entry.section, items)
  }
  return [...sections].map(([label, items]) => ({ id: label, label, items }))
})
</script>

<template>
  <UModal v-model:open="open" title="Search documentation" description="Find pages and sections in the L4 docs." :ui="{ content: 'sm:max-w-2xl' }">
    <UButton icon="i-ph-magnifying-glass" color="neutral" variant="outline" class="w-full justify-start text-muted sm:w-56" aria-label="Search documentation">
      <span class="flex-1 text-left">Search docs</span>
      <UKbd value="meta" class="hidden sm:inline-flex" /><UKbd value="K" class="hidden sm:inline-flex" />
    </UButton>
    <template #content>
      <UCommandPalette :groups="groups" :loading="loading" placeholder="Search documentation…" :fuse="{ resultLimit: 30, fuseOptions: { keys: ['label', 'suffix'], threshold: 0.35 } }" class="h-96" close @update:open="open = $event" />
    </template>
  </UModal>
</template>

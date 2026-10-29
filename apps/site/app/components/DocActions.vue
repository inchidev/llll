<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { SITE } from '../../lib/site.mjs'

// Agent-friendly actions for one page: copy or open its Markdown, ask an
// assistant about it, or edit its source on GitHub.
const props = defineProps<{ markdownPath: string, file?: string }>()
const copied = ref(false)
const absolute = computed(() => SITE.origin + props.markdownPath)
const prompt = computed(() => `Read ${absolute.value} so I can ask questions about it.`)

async function copyPage() {
  const response = await fetch(props.markdownPath)
  if (!response.ok) return
  await navigator.clipboard.writeText(await response.text())
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}

const items = computed<DropdownMenuItem[][]>(() => [[
  { label: 'View as Markdown', icon: 'i-ph-file-text', to: props.markdownPath, target: '_blank' },
  { label: 'Open in Claude', icon: 'i-ph-chat-circle-dots', to: `https://claude.ai/new?q=${encodeURIComponent(prompt.value)}`, target: '_blank' },
  { label: 'Open in ChatGPT', icon: 'i-ph-chat-circle-dots', to: `https://chatgpt.com/?q=${encodeURIComponent(prompt.value)}`, target: '_blank' },
], ...(props.file ? [[{ label: 'Edit on GitHub', icon: 'i-ph-github-logo', to: `${SITE.repo}/edit/main/${props.file.startsWith('docs/release-notes/') ? props.file : 'apps/site/content/' + props.file}`, target: '_blank' }]] : [])])
</script>

<template>
  <UFieldGroup size="sm">
    <UButton :label="copied ? 'Copied' : 'Copy page'" :icon="copied ? 'i-ph-check' : 'i-ph-copy'" color="neutral" variant="outline" @click="copyPage" />
    <UDropdownMenu :items="items" :content="{ align: 'end' }">
      <UButton icon="i-ph-caret-down" color="neutral" variant="outline" aria-label="More page actions" />
    </UDropdownMenu>
  </UFieldGroup>
</template>

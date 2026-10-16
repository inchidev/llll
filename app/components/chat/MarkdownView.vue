<script setup lang="ts">
import { renderMarkdown } from '~~/shared/markdown'

const props = defineProps<{
  content: string
  names?: Record<string, string>
}>()

const html = computed(() => renderMarkdown(props.content, props.names))

function reveal(target: Element) {
  const spoiler = target.closest('.spoiler')
  if (!spoiler || spoiler.classList.contains('revealed')) return false
  spoiler.classList.add('revealed')
  spoiler.removeAttribute('role')
  spoiler.removeAttribute('tabindex')
  return true
}

// Links to this installation (such as copied message links) stay in the app.
function onClick(event: MouseEvent) {
  const target = event.target as Element | null
  if (!target) return
  if (reveal(target)) {
    event.preventDefault()
    return
  }
  const anchor = target.closest('a')
  if (!anchor || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const url = new URL(anchor.href, window.location.href)
  if (url.origin !== window.location.origin) return
  event.preventDefault()
  void navigateTo(`${url.pathname}${url.search}${url.hash}`)
}

function onKey(event: KeyboardEvent) {
  if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && reveal(event.target)) {
    event.preventDefault()
  }
}
</script>

<template>
  <!-- markdown.ts escapes HTML and drops javascript: URLs -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="md break-words" @click="onClick" @keydown="onKey" v-html="html" />
</template>

<script setup lang="ts">
// Prerendered Markdown HTML from apps/site/lib/content.mjs. Code blocks get a
// copy button once the page is interactive.
const props = defineProps<{ html: string }>()
const root = ref<HTMLElement>()

function addCopyButtons() {
  for (const pre of root.value?.querySelectorAll('pre') || []) {
    if (pre.querySelector('.copy-code')) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'copy-code'
    button.textContent = 'Copy'
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(pre.querySelector('code')?.textContent || '')
      button.textContent = 'Copied'
      setTimeout(() => { button.textContent = 'Copy' }, 1500)
    })
    pre.append(button)
  }
}
onMounted(addCopyButtons)
watch(() => props.html, () => nextTick(addCopyButtons))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- trusted Markdown rendered at build time from this repository -->
  <div ref="root" class="prose-content" v-html="html" />
</template>

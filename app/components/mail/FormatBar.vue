<script setup lang="ts">
/**
 * Formatting for an email being written. It inserts Markdown into the text box;
 * the Server turns it into sanitized HTML and sends the text alongside.
 */
const props = defineProps<{ field: { textareaRef?: HTMLTextAreaElement } | null }>()
const text = defineModel<string>({ required: true })
const format = defineModel<'text' | 'markdown'>('format', { required: true })

function edit(change: (value: string, start: number, end: number) => { value: string; start: number; end: number }) {
  const element = props.field?.textareaRef
  const start = element?.selectionStart ?? text.value.length
  const end = element?.selectionEnd ?? text.value.length
  const next = change(text.value, start, end)
  text.value = next.value
  void nextTick(() => { element?.focus(); element?.setSelectionRange(next.start, next.end) })
}

function wrap(before: string, after: string, placeholder: string) {
  edit((value, start, end) => {
    const selected = value.slice(start, end) || placeholder
    return { value: value.slice(0, start) + before + selected + after + value.slice(end), start: start + before.length, end: start + before.length + selected.length }
  })
}

/** Marks every selected line, as a list item or a quote. */
function lines(marker: (index: number) => string) {
  edit((value, start, end) => {
    const from = value.lastIndexOf('\n', start - 1) + 1
    const marked = value.slice(from, end).split('\n').map((line, index) => marker(index) + line).join('\n')
    return { value: value.slice(0, from) + marked + value.slice(end), start: from, end: from + marked.length }
  })
}

const tools = [
  { label: 'Bold', icon: 'i-ph-text-b', run: () => wrap('**', '**', 'bold text') },
  { label: 'Italic', icon: 'i-ph-text-italic', run: () => wrap('_', '_', 'italic text') },
  { label: 'Link', icon: 'i-ph-link', run: () => wrap('[', '](https://)', 'link text') },
  { label: 'Bulleted list', icon: 'i-ph-list-bullets', run: () => lines(() => '- ') },
  { label: 'Numbered list', icon: 'i-ph-list-numbers', run: () => lines(index => `${index + 1}. `) },
  { label: 'Quote', icon: 'i-ph-quotes', run: () => lines(() => '> ') },
]
</script>

<template>
  <div class="flex flex-wrap items-center gap-0.5">
    <UTooltip :text="format === 'markdown' ? 'Send as plain text' : 'Format this email'">
      <UButton
        icon="i-ph-text-aa"
        size="xs"
        color="neutral"
        :variant="format === 'markdown' ? 'soft' : 'ghost'"
        square
        :aria-pressed="format === 'markdown'"
        aria-label="Formatting"
        @click="format = format === 'markdown' ? 'text' : 'markdown'"
      />
    </UTooltip>
    <template v-if="format === 'markdown'">
      <UTooltip v-for="tool in tools" :key="tool.label" :text="tool.label">
        <UButton :icon="tool.icon" size="xs" color="neutral" variant="ghost" square :aria-label="tool.label" @click="tool.run" />
      </UTooltip>
    </template>
  </div>
</template>

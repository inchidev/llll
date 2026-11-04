<script setup lang="ts">
const draft = defineModel<string>({ required: true })
const emit = defineEmits<{ save: [], cancel: [] }>()

const field = ref<{ textareaRef?: HTMLTextAreaElement } | null>(null)

onMounted(() => {
  nextTick(() => {
    const el = field.value?.textareaRef
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  })
})

function onKey(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    emit('save')
  }
  else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
  }
}
</script>

<template>
  <div class="my-1">
    <div class="df-composer rounded-lg px-2">
      <UTextarea
        ref="field"
        v-model="draft"
        autoresize
        :rows="1"
        :maxrows="12"
        variant="none"
        color="neutral"
        class="w-full"
        aria-label="Edit message"
        :ui="{ base: () => 'w-full bg-transparent px-1 py-2 text-base leading-snug text-default resize-none focus:outline-none' }"
        @keydown="onKey"
      />
    </div>
    <p class="mt-1 text-xs text-muted">
      escape to <button type="button" class="text-info hover:underline" @click="emit('cancel')">cancel</button>
      • enter to <button type="button" class="text-info hover:underline" @click="emit('save')">save</button>
    </p>
  </div>
</template>

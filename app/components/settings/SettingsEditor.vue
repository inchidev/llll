<script setup lang="ts">
import { inject, onBeforeUnmount, watch } from 'vue'
import { settingsEditorKey } from '../../composables/useSettingsEditor'

const props = withDefaults(defineProps<{ title: string; description?: string; back?: string; dismissible?: boolean; close?: boolean; ui?: Record<string, unknown> }>(), { description: undefined, back: 'Settings', dismissible: true, close: true, ui: undefined })
const open = defineModel<boolean>('open', { default: false })
const editor = inject(settingsEditorKey, null)
const identity = Symbol('settings-editor-instance')
function goBack() { if (props.dismissible) open.value = false }
watch(open, value => {
  if (!editor) return
  if (value) editor.active.value = identity
  else if (editor.active.value === identity) editor.active.value = null
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { if (editor?.active.value === identity) editor.active.value = null })
</script>
<template>
  <Teleport v-if="editor && editor.target.value && open" :to="editor.target.value">
    <div class="space-y-6">
      <SettingsHeader :title="title" :description="description" :back="props.back" @back="goBack" />
      <slot name="body" />
      <div v-if="$slots.footer" class="flex flex-wrap justify-end gap-2"><slot name="footer" /></div>
    </div>
  </Teleport>
  <UModal v-else-if="!editor" v-model:open="open" :title="title" :description="description" :dismissible="dismissible" :close="close" :ui="ui">
    <template #body><slot name="body" /></template>
    <template v-if="$slots.footer" #footer><slot name="footer" /></template>
  </UModal>
</template>

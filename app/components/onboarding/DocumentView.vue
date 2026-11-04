<script setup lang="ts">
import type { RichTextDocument } from '~~/shared/types'

defineProps<{ content: RichTextDocument }>()
</script>

<template>
  <ClientOnly>
    <UEditor
      :model-value="content"
      :editable="false"
      :image="false"
      :mention="false"
      :ui="{
        root: 'min-w-0',
        content: 'min-h-0',
        base: 'px-0 sm:px-0',
      }"
    />
    <template #fallback>
      <USkeleton class="h-40 w-full" />
    </template>
  </ClientOnly>
</template>

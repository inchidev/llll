<script setup lang="ts">
import AudioPlayer from './AudioPlayer.vue'

const props = defineProps<{
  files: File[]
}>()

const emit = defineEmits<{
  remove: [index: number]
}>()

type DraftPreview = {
  file: File
  url: string | null
  kind: 'image' | 'audio' | 'file'
}

const previews = shallowRef<DraftPreview[]>([])

function revokePreviews() {
  for (const preview of previews.value) {
    if (preview.url) URL.revokeObjectURL(preview.url)
  }
}

watch(() => props.files, (files) => {
  revokePreviews()
  previews.value = files.map((file) => {
    const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'file'
    return {
      file,
      kind,
      url: kind === 'file' ? null : URL.createObjectURL(file),
    }
  })
}, { immediate: true })

onBeforeUnmount(revokePreviews)
</script>

<template>
  <div class="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attachments ready to send">
    <div
      v-for="(preview, index) in previews"
      :key="`${preview.file.name}:${preview.file.lastModified}:${index}`"
      class="relative flex max-w-full flex-col overflow-hidden rounded-lg bg-muted ring ring-default"
      :class="preview.kind === 'audio' ? 'w-72' : 'w-24'"
    >
      <img
        v-if="preview.kind === 'image' && preview.url"
        :src="preview.url"
        :alt="preview.file.name"
        class="block aspect-square w-full bg-elevated object-contain"
      >
      <div v-else-if="preview.kind === 'audio' && preview.url" class="flex min-h-16 items-center px-2 pt-2">
        <AudioPlayer :src="preview.url" :label="preview.file.name" />
      </div>
      <div v-else class="flex aspect-square w-full items-center justify-center">
        <UIcon name="i-ph-file" class="size-8 text-muted" />
      </div>
      <span class="truncate px-2 py-1.5 text-xs text-default" :title="preview.file.name">
        {{ preview.file.name }}
      </span>
      <UTooltip :text="`Remove ${preview.file.name}`">
        <UButton
          icon="i-ph-x"
          color="neutral"
          variant="solid"
          size="xs"
          square
          class="absolute end-1 top-1 rounded-full"
          :aria-label="`Remove ${preview.file.name}`"
          @click="emit('remove', index)"
        />
      </UTooltip>
    </div>
  </div>
</template>

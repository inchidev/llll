<script setup lang="ts">
import { onKeyStroke } from '@vueuse/core'
import type { AttachmentDTO } from '~~/shared/types'
import { formatBytes } from '~~/shared/format'
import AudioPlayer from './AudioPlayer.vue'

const props = defineProps<{
  attachments: AttachmentDTO[]
}>()
const { serverUrl } = useApi()

const images = computed(() => props.attachments.filter(attachment => attachment.contentType.startsWith('image/')))
const audio = computed(() => props.attachments.filter(attachment => attachment.contentType.startsWith('audio/')))
const files = computed(() => props.attachments.filter(attachment => !attachment.contentType.startsWith('image/') && !attachment.contentType.startsWith('audio/')))
const galleryOpen = ref(false)
const activeIndex = ref(0)
const activeImage = computed(() => images.value[activeIndex.value] ?? null)

function openImage(index: number) {
  activeIndex.value = index
  galleryOpen.value = true
}

function previous() {
  if (images.value.length < 2) return
  activeIndex.value = (activeIndex.value - 1 + images.value.length) % images.value.length
}

function next() {
  if (images.value.length < 2) return
  activeIndex.value = (activeIndex.value + 1) % images.value.length
}

onKeyStroke('ArrowLeft', (event) => {
  if (!galleryOpen.value) return
  event.preventDefault()
  previous()
})
onKeyStroke('ArrowRight', (event) => {
  if (!galleryOpen.value) return
  event.preventDefault()
  next()
})
</script>

<template>
  <div class="mt-2 flex max-w-2xl flex-col items-start gap-2">
    <div
      v-if="images.length"
      class="grid max-w-full gap-1 overflow-hidden rounded-lg"
      :class="images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'"
    >
      <button
        v-for="(image, index) in images"
        :key="image.id"
        type="button"
        class="group/image min-w-0 overflow-hidden rounded-md bg-muted text-start focus-visible:outline-2 focus-visible:outline-primary"
        :class="images.length === 1 ? 'self-start' : 'aspect-square'"
        :aria-label="`Preview ${image.filename}`"
        @click="openImage(index)"
      >
        <img
          :src="serverUrl(image.url)"
          :alt="image.filename"
          class="block max-w-full transition-opacity group-hover/image:opacity-90"
          :class="images.length === 1
            ? 'h-auto w-auto max-h-80 object-contain'
            : 'size-full object-cover'"
        >
      </button>
    </div>

    <div
      v-for="clip in audio"
      :key="clip.id"
      class="w-full max-w-sm"
    >
      <AudioPlayer :src="serverUrl(clip.url)" :label="clip.filename" />
    </div>

    <ULink
      v-for="file in files"
      :key="file.id"
      :to="serverUrl(file.url)"
      target="_blank"
      class="inline-flex max-w-full items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"
    >
      <UIcon name="i-ph-file" class="size-5 shrink-0" />
      <span class="truncate">{{ file.filename }}</span>
      <span class="shrink-0 text-muted">{{ formatBytes(file.sizeBytes) }}</span>
    </ULink>

    <UModal
      v-model:open="galleryOpen"
      :title="activeImage?.filename || 'Image preview'"
      :description="images.length > 1 ? `${activeIndex + 1} of ${images.length}` : undefined"
      :ui="{ content: 'sm:max-w-5xl' }"
    >
      <template #body>
        <div v-if="activeImage" class="relative flex min-h-48 items-center justify-center overflow-hidden rounded-lg bg-black/30">
          <img
            :src="serverUrl(activeImage.url)"
            :alt="activeImage.filename"
            class="block h-auto w-auto max-h-[75vh] max-w-full object-contain"
          >
          <template v-if="images.length > 1">
            <UTooltip text="Previous image">
              <UButton
                icon="i-ph-caret-left"
                color="neutral"
                variant="solid"
                size="lg"
                square
                class="absolute start-3 top-1/2 -translate-y-1/2 rounded-full"
                aria-label="Previous image"
                @click="previous"
              />
            </UTooltip>
            <UTooltip text="Next image">
              <UButton
                icon="i-ph-caret-right"
                color="neutral"
                variant="solid"
                size="lg"
                square
                class="absolute end-3 top-1/2 -translate-y-1/2 rounded-full"
                aria-label="Next image"
                @click="next"
              />
            </UTooltip>
          </template>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full items-center gap-2">
          <span v-if="images.length > 1" class="text-sm text-muted">{{ activeIndex + 1 }} / {{ images.length }}</span>
          <UButton
            v-if="activeImage"
            :to="serverUrl(activeImage.url)"
            target="_blank"
            icon="i-ph-arrow-square-out"
            label="Open original"
            color="neutral"
            variant="soft"
            class="ms-auto"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>

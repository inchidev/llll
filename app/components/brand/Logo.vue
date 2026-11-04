<script setup lang="ts">
const sizes = {
  xs: 16,
  sm: 20,
  md: 24,
  lg: 32,
  xl: 40,
  '2xl': 48,
  '3xl': 64,
  hero: 96,
} as const

type NamedSize = keyof typeof sizes

const files = [
  { px: 32, src: '/brand/logo-32.png' },
  { px: 64, src: '/brand/logo-64.png' },
  { px: 128, src: '/brand/logo-128.png' },
  { px: 256, src: '/brand/logo-256.png' },
  { px: 512, src: '/brand/logo-512.png' },
] as const

const props = withDefaults(defineProps<{
  size?: NamedSize
  alt?: string
  priority?: boolean
}>(), {
  size: 'md',
  alt: 'L4',
  priority: false,
})

const px = computed(() => sizes[props.size ?? 'md'])

const src = computed(() => {
  const need = px.value * 2
  return files.find((file) => file.px >= need)?.src ?? files[files.length - 1]!.src
})

const srcset = files.map((file) => `${file.src} ${file.px}w`).join(', ')
</script>

<template>
  <img
    :src="src"
    :srcset="srcset"
    :sizes="`${px}px`"
    :width="px"
    :height="px"
    :alt="alt"
    :fetchpriority="priority ? 'high' : undefined"
    decoding="async"
    draggable="false"
    class="shrink-0 select-none"
    :style="{ width: `${px}px`, height: `${px}px` }"
  >
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  compact?: boolean
  name?: string
  size?: 'sm' | 'md' | 'lg'
}>(), {
  compact: false,
  name: 'L4',
  size: 'md',
})

const variant = computed(() => props.compact ? 'sm' : props.size)

const logoSize = computed(() => {
  if (variant.value === 'sm') return 'sm' as const
  if (variant.value === 'lg') return 'xl' as const
  return 'lg' as const
})

const textClass = computed(() => {
  if (variant.value === 'sm') return 'text-sm'
  if (variant.value === 'lg') return 'text-xl'
  return 'text-lg'
})

const gapClass = computed(() => {
  if (variant.value === 'sm') return 'gap-2'
  if (variant.value === 'lg') return 'gap-3'
  return 'gap-2.5'
})
</script>

<template>
  <div class="flex items-center" :class="gapClass">
    <slot name="icon"><BrandLogo :size="logoSize" alt="" :priority="variant !== 'sm'" /></slot>
    <span class="font-brand font-semibold tracking-tight text-highlighted" :class="textClass">{{ props.name }}</span>
  </div>
</template>

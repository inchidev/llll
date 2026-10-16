<script setup lang="ts">
const props = withDefaults(defineProps<{
  min: number
  max: number
  side?: 'start' | 'end'
  label: string
}>(), { side: 'end' })
const width = defineModel<number>({ required: true })
/** Fires once a drag or keyboard resize settles, for callers that save the width. */
const emit = defineEmits<{ end: [width: number] }>()

let stopDragging: (() => void) | null = null

function clamp(value: number) {
  return Math.min(props.max, Math.max(props.min, value))
}

function startDragging(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  const startX = event.clientX
  const startWidth = width.value
  const direction = props.side === 'end' ? 1 : -1
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'

  const move = (moveEvent: PointerEvent) => {
    width.value = clamp(startWidth + (moveEvent.clientX - startX) * direction)
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    stopDragging = null
    emit('end', width.value)
  }
  stopDragging = stop
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop, { once: true })
  window.addEventListener('pointercancel', stop, { once: true })
}

function resizeWithKeyboard(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const physicalDelta = event.key === 'ArrowRight' ? 12 : -12
  width.value = clamp(width.value + physicalDelta * (props.side === 'end' ? 1 : -1))
  emit('end', width.value)
}

onUnmounted(() => stopDragging?.())
</script>

<template>
  <button
    type="button"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="Math.round(width)"
    class="absolute inset-y-0 z-30 w-1.5 cursor-col-resize bg-transparent hover:bg-primary/50 focus-visible:bg-primary/60 focus-visible:outline-none"
    :class="side === 'end' ? '-end-0.5' : '-start-0.5'"
    @pointerdown="startDragging"
    @keydown="resizeWithKeyboard"
  />
</template>

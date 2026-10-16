<script setup lang="ts">
const previews = [
  { label: 'Chat', icon: 'i-ph-chats-circle', value: 'chat', src: '/screenshots/chat.jpg', alt: 'L4 Chat showing a team planning a launch in a channel.' },
  { label: 'Tasks', icon: 'i-ph-kanban', value: 'tasks', src: '/screenshots/tasks.jpg', alt: 'L4 Tasks showing a launch board with work organized by status.' },
  { label: 'Mail', icon: 'i-ph-envelope-simple', value: 'mail', src: '/screenshots/mail.jpg', alt: 'L4 Mail showing a shared team inbox and an email conversation.' },
  { label: 'Data', icon: 'i-ph-table', value: 'data', src: '/screenshots/data.jpg', alt: 'L4 Data showing a shared client database with typed fields and records.' },
]

const selectedPreview = ref('chat')
let touchStart: { x: number, y: number } | null = null

function onTouchStart(event: TouchEvent) {
  const touch = event.touches[0]
  touchStart = event.touches.length === 1 && touch
    ? { x: touch.clientX, y: touch.clientY }
    : null
}

function onTouchEnd(event: TouchEvent) {
  const start = touchStart
  touchStart = null
  const touch = event.changedTouches[0]
  if (!start || !touch || event.touches.length) return

  const deltaX = touch.clientX - start.x
  const deltaY = touch.clientY - start.y
  if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY)) return

  const index = previews.findIndex(preview => preview.value === selectedPreview.value)
  const nextIndex = (index + (deltaX < 0 ? 1 : -1) + previews.length) % previews.length
  selectedPreview.value = previews[nextIndex]!.value
}
</script>

<template>
  <UTabs v-model="selectedPreview" :items="previews" :ui="{ list: 'mx-auto w-full max-w-lg', indicator: 'hidden', trigger: 'rounded-lg', content: 'mt-5' }">
    <template #content="{ item }">
      <figure>
        <div
          class="touch-[pan-y_pinch-zoom] overflow-hidden rounded-[8px] border border-muted bg-elevated shadow-xl"
          @touchstart.passive="onTouchStart"
          @touchend.passive="onTouchEnd"
          @touchcancel="touchStart = null"
        >
          <img :src="item.src" :alt="item.alt" width="1280" height="720" loading="lazy" decoding="async" class="aspect-video w-full object-contain">
        </div>
        <figcaption class="mt-4 text-center text-xs leading-5 text-dimmed">{{ item.label }}, inherited from Discoflare, with sample content. <a :href="`#app-${item.value}`" class="text-primary hover:underline">Explore {{ item.label }}</a></figcaption>
      </figure>
    </template>
  </UTabs>
</template>

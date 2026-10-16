<script setup lang="ts">
import { useMounted } from '@vueuse/core'
import { workspaceConnectionKey } from '../../composables/useWorkspaceSocket'

const ui = useUiStore()
const props = defineProps<{
  workspaceId?: string
}>()
const { workspaceId: defaultWorkspaceId } = useWorkspace()

const isMobile = useIsMobile()
const workspaceId = computed(() => props.workspaceId || defaultWorkspaceId.value || ui.last()?.workspaceId)

// Presence, unread dots, and incoming calls must keep working on every page, not
// only while a conversation is open, so the workspace connection lives here.
const session = useSessionStore()
const presence = usePresenceStore()
watch(() => session.user?.id, id => presence.setSelf(id ?? null), { immediate: true })
const { connection: workspaceConnection } = useWorkspaceSocket(() => workspaceId.value || '')
provide(workspaceConnectionKey, workspaceConnection)
const open = computed(() => ui.mobilePane === 'channels')

// Follow the router's live route: page-level routes miss child-only changes,
// such as opening a thread of the current channel from the drawer.
const liveRoute = useRouter().currentRoute
watch(() => liveRoute.value.fullPath, () => {
  if (isMobile.value) ui.mobilePane = 'chat'
})

// Swipe right anywhere to open the navigation drawer, swipe left to close it.
// The drawer follows the finger and settles by distance or flick velocity.
const drawer = ref<HTMLElement | null>(null)
const dragOffset = ref<number | null>(null)
let gesture: { x: number, y: number, t: number, width: number, axis: 'x' | 'y' | null, fromOpen: boolean } | null = null

const EDGE_PX = 24
const AXIS_LOCK_PX = 10

function scrollsHorizontally(target: EventTarget | null) {
  let node = target instanceof Element ? target : null
  while (node && node !== document.body) {
    if (node instanceof HTMLElement) {
      if (node.dataset.noDrawerSwipe !== undefined) return true
      if (node.scrollWidth > node.clientWidth + 1) {
        const overflow = getComputedStyle(node).overflowX
        if (overflow === 'auto' || overflow === 'scroll') return true
      }
    }
    node = node.parentElement
  }
  return false
}

function onTouchStart(event: TouchEvent) {
  if (!isMobile.value || !workspaceId.value || event.touches.length !== 1) return
  if (ui.mobilePane === 'members') return
  const touch = event.touches[0]!
  const target = event.target
  if (!open.value && touch.clientX > EDGE_PX && scrollsHorizontally(target)) return
  if (target instanceof Element && target.closest('input[type="range"], [role="slider"], [contenteditable="true"] *')) return
  gesture = {
    x: touch.clientX,
    y: touch.clientY,
    t: performance.now(),
    width: drawer.value?.offsetWidth || 300,
    axis: null,
    fromOpen: open.value,
  }
}

function onTouchMove(event: TouchEvent) {
  if (!gesture) return
  const touch = event.touches[0]!
  const dx = touch.clientX - gesture.x
  const dy = touch.clientY - gesture.y
  if (!gesture.axis) {
    if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
    gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'
    if (gesture.axis === 'y' || (gesture.fromOpen ? dx > 0 : dx < 0)) {
      gesture = null
      return
    }
  }
  const base = gesture.fromOpen ? gesture.width : 0
  dragOffset.value = Math.min(gesture.width, Math.max(0, base + dx))
}

function onTouchEnd(event: TouchEvent) {
  if (!gesture) return
  const current = gesture
  gesture = null
  if (dragOffset.value === null) return
  const dx = (event.changedTouches[0]?.clientX ?? current.x) - current.x
  const velocity = dx / Math.max(1, performance.now() - current.t)
  const shouldOpen = Math.abs(velocity) > 0.4
    ? velocity > 0
    : dragOffset.value > current.width / 2
  dragOffset.value = null
  ui.mobilePane = shouldOpen ? 'channels' : 'chat'
}

// The phone/desktop split lives in CSS (see .channel-drawer) so the first paint is
// right before hydration; script only adds the open state and finger tracking.
const mounted = useMounted()
const drawerStyle = computed(() => {
  // The saved width lives in localStorage, which the server cannot see; apply it
  // after mount so hydration matches and the CSS default covers the first paint.
  if (!mounted.value) return {}
  if (!isMobile.value) return { '--channel-pane-width': `${ui.channelPaneWidth}px` }
  if (dragOffset.value !== null) {
    return { transform: `translateX(calc(${dragOffset.value}px - 100%))`, transition: 'none' }
  }
  return { transform: open.value ? 'translateX(0)' : 'translateX(-100%)' }
})

const backdropOpacity = computed(() => {
  if (dragOffset.value !== null) return dragOffset.value / (drawer.value?.offsetWidth || 300)
  return open.value ? 1 : 0
})

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isMobile.value && open.value) ui.mobilePane = 'chat'
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    class="relative flex h-full overflow-hidden bg-default"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd"
    @touchcancel.passive="onTouchEnd"
  >
    <aside
      v-if="workspaceId"
      id="channel-navigation"
      ref="drawer"
      class="channel-drawer flex min-h-0 shrink-0 flex-col bg-muted pb-[var(--df-safe-area-bottom)] pt-[var(--df-safe-area-top)]"
      :style="drawerStyle"
      :aria-hidden="isMobile && !open && dragOffset === null ? 'true' : undefined"
      :inert="isMobile && !open && dragOffset === null ? true : undefined"
    >
      <LayoutNavShell :workspace-id="workspaceId" />
      <LayoutResizeHandle
        v-if="!isMobile"
        v-model="ui.channelPaneWidth"
        :min="200"
        :max="360"
        side="end"
        label="Resize channel panel"
      />
    </aside>
    <button
      v-if="workspaceId"
      type="button"
      class="channel-backdrop absolute inset-0 z-20 bg-black/60 md:hidden"
      :class="open || dragOffset !== null ? '' : 'pointer-events-none'"
      :style="{ opacity: backdropOpacity, transition: dragOffset !== null ? 'none' : undefined }"
      tabindex="-1"
      aria-label="Close navigation"
      @click="ui.mobilePane = 'chat'"
    />
    <div class="flex min-h-0 min-w-0 flex-1 flex-col pb-[var(--df-safe-area-bottom)] pt-[var(--df-safe-area-top)]">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* Phones: an off-canvas drawer over the page. */
.channel-drawer {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  z-index: 30;
  width: min(22rem, 86vw);
  transform: translateX(-100%);
  box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5);
  transition: transform 260ms cubic-bezier(0.32, 0.72, 0, 1);
  will-change: transform;
}

/* Wider screens: a resizable column beside the page. */
@media (min-width: 768px) {
  .channel-drawer {
    position: relative;
    z-index: auto;
    width: var(--channel-pane-width, 240px);
    transform: none;
    box-shadow: none;
    transition: none;
  }
}

.channel-backdrop {
  opacity: 0;
}

.channel-backdrop {
  transition: opacity 220ms ease;
}

@media (prefers-reduced-motion: reduce) {
  .channel-drawer,
  .channel-backdrop {
    transition-duration: 1ms;
  }
}
</style>

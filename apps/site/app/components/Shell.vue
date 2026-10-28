<script setup lang="ts">
import CommunityRail from '../../../../packages/client-ui/CommunityRail.vue'
import { SERVER_UNREACHABLE } from '../composables/useShell'
import { normalizeRoutePath } from '../utils/shell-route'
import { readDeploymentClaim } from '../../../../shared/deploy-handoff'

const shell = useShell()
const route = useRoute()
const ownOrigin = ref('')
const error = shell.error
const pendingMessages = computed(() => Object.values(shell.pendingMessages.value).some(Boolean))
function warnPendingMessages(event: BeforeUnloadEvent) {
  if (!pendingMessages.value) return
  event.preventDefault()
  event.returnValue = ''
}
watch(pendingMessages, (pending) => {
  if (typeof window === 'undefined') return
  if (pending) window.addEventListener('beforeunload', warnPendingMessages)
  else window.removeEventListener('beforeunload', warnPendingMessages)
}, { flush: 'sync', immediate: true })
onUnmounted(() => window.removeEventListener('beforeunload', warnPendingMessages))
const path = computed(() => normalizeRoutePath(route.path))
const queryOrigin = computed(() => {
  // Installer handoffs use server as a target, not a request to open its Client.
  if (route.query.update || route.query.storage || route.query.resume === 'update' || route.query.tab === 'cloudflare') return ''
  const value = route.query.server
  return typeof value === 'string' ? value : ''
})
const queryClaim = computed(() => readDeploymentClaim(route.hash))
const checkingAddress = ref('')
const frameVersions = ref<Record<string, number>>({})
const frameSlow = ref(false)
let frameTimer: ReturnType<typeof setTimeout> | undefined
function waitForFrame() {
  clearTimeout(frameTimer); frameSlow.value = false
  if (shell.selected.value && !shell.unclaimed.value[shell.selected.value] && !shell.ready.value[shell.selected.value]) frameTimer = setTimeout(() => { frameSlow.value = true }, 15000)
}
function retryFrame() {
  const origin = shell.selected.value
  shell.ready.value[origin] = false
  frameVersions.value[origin] = (frameVersions.value[origin] || 0) + 1
  waitForFrame()
}
watch(() => [shell.selected.value, shell.ready.value[shell.selected.value], shell.unclaimed.value[shell.selected.value]], waitForFrame)
onUnmounted(() => clearTimeout(frameTimer))
function openServer(origin: string, id: string) {
  const server = shell.servers.value.find(
    (item) => item.origin === origin,
  )
  if (server) {
    shell.open(server, id)
  }
}
function connect() {
  shell.selected.value = ''
  void navigateTo('/create')
}
function home(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  shell.selected.value = ''
  void navigateTo('/servers')
}
const showCreate = computed(() => path.value === '/create')
const showHome = computed(() => path.value === '/servers')
const showNavigation = computed(() => showCreate.value || showHome.value)
// Phones get the Client full width, like Discord: the rail joins its navigation drawer.
// It stays on whenever the Client has no drawer to open (Shell pages, loading, sign-in)
// and for older Clients that never report their drawer.
const railOnPhone = computed(() => {
  const origin = shell.selected.value
  return showNavigation.value || !origin || !shell.ready.value[origin] || Boolean(shell.unclaimed.value[origin])
    || shell.signedIn.value[origin] === false || shell.drawers.value[origin] !== false
})
/** The shell survives route changes as a v-show'd component, and its connect-on-mount check cannot run again.
 * When the deploy completion screen or a saved Server link navigates to /create?server=…,
 * connect here (with one bounded retry: a freshly deployed Server may not answer right away). */
let lastAutoOrigin = ''
let lastAutoClaim: string | undefined
async function connectQuery(
  origin: string,
  claim: string | undefined,
  attempt = 0,
) {
  try {
    const server = await shell.connect(origin, claim)
    error.value = ''
    return server
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Could not connect'
    if (!attempt && message === SERVER_UNREACHABLE) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 4000))
      return connectQuery(origin, claim, 1)
    }
    error.value = message
    // Keep the failed address in the form so a retry is one click on Connect.
    shell.address.value = origin
  }
}
async function handleQuery(queryOrigin: string, claim: string | undefined) {
  if (queryOrigin === lastAutoOrigin && claim === lastAutoClaim) return
  lastAutoOrigin = queryOrigin
  lastAutoClaim = claim
  if (!queryOrigin) return
  checkingAddress.value = queryOrigin
  await connectQuery(queryOrigin, claim).finally(() => {
    checkingAddress.value = ''
  })
}
function selectFrame(element: unknown, origin: string) {
  if (element instanceof HTMLIFrameElement) shell.frames.value[origin] = element
  else {
    Reflect.deleteProperty(shell.frames.value, origin)
    Reflect.deleteProperty(shell.pendingMessages.value, origin)
  }
}
function refreshMetadata() {
  if (!document.hidden && (showNavigation.value || route.params.serverId)) void shell.refreshMetadata()
}
let metadataTimer: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  ownOrigin.value = location.origin
  shell.initialize()
  refreshMetadata()
  window.addEventListener('focus', refreshMetadata)
  document.addEventListener('visibilitychange', refreshMetadata)
  metadataTimer = setInterval(() => {
    const origin = shell.selected.value
    if (!document.hidden && origin && shell.unclaimed.value[origin]) void shell.readMetadata(origin).catch(() => {})
    else refreshMetadata()
  }, 10000)
  if (showNavigation.value) shell.selected.value = ''
  if (showCreate.value && queryOrigin.value) await handleQuery(queryOrigin.value, queryClaim.value)
  else if (route.params.serverId) await mountServer()
})
onUnmounted(() => {
  clearInterval(metadataTimer)
  window.removeEventListener('focus', refreshMetadata)
  document.removeEventListener('visibilitychange', refreshMetadata)
})
watch(
  () => route.fullPath,
  async () => {
    if (showNavigation.value) shell.selected.value = ''
    refreshMetadata()
    if (path.value === '/create' && queryOrigin.value)
      await handleQuery(queryOrigin.value, queryClaim.value)
    else if (route.params.serverId) await mountServer()
  },
)
async function mountServer() {
  try {
    await shell.resolveServer()
  } catch {
    error.value = 'This Server is unavailable. Connect it by address or open its own website.'
    await navigateTo('/create')
  }
}
</script>

<template>
  <main class="flex h-dvh overflow-hidden bg-default">
    <div class="shrink-0" :class="railOnPhone ? 'block' : 'hidden md:block'">
      <CommunityRail
        :groups="shell.groups.value"
        home-href="/servers"
        home-label="My Servers"
        :home-active="showHome"
        :active-origin="showNavigation ? undefined : shell.selected.value"
        :active-server-id="
          !showNavigation && typeof route.params.serverId === 'string'
            ? route.params.serverId
            : undefined
        "
        :add-active="showCreate"
        @home="home"
        @server="openServer"
        @connect="connect"
      />
    </div>
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <section class="relative min-h-0 min-w-0 flex-1">
        <iframe
          v-for="origin in shell.loaded.value.filter(item => !shell.unclaimed.value[item])"
          v-show="shell.selected.value === origin && !showNavigation"
          :key="origin + (frameVersions[origin] || 0)"
          :ref="(element) => selectFrame(element, origin)"
          :src="shell.frameSrc(origin, ownOrigin)"
          :title="`${shell.servers.value.find((i) => i.origin === origin)?.name || 'L4'} server`"
          class="absolute inset-0 h-full w-full border-0"
          allow="camera; microphone; display-capture; fullscreen; clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          referrerpolicy="no-referrer"
        />
        <div v-if="!showNavigation && shell.selected.value && shell.unclaimed.value[shell.selected.value]" class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-default p-6 text-center">
          <h1 class="text-lg font-semibold">Finish setting up your Server</h1><p class="max-w-md text-sm text-muted">Choose your owner password on the Server’s own website. This page will open its Client when setup is complete.</p>
          <UButton :to="shell.ownerSetupUrl(shell.selected.value)" external target="_blank" rel="noopener" label="Finish setup on your Server" />
        </div>
        <div v-else-if="!showNavigation && shell.selected.value && !shell.ready.value[shell.selected.value]" role="status" class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-default p-6 text-center">
          <UIcon v-if="!frameSlow" name="i-ph-circle-notch" class="size-7 animate-spin text-muted" />
          <p class="text-sm text-muted">{{ frameSlow ? 'The Server is taking longer to open.' : 'Opening your Server…' }}</p>
          <template v-if="frameSlow"><UButton label="Try again" @click="retryFrame" /><UButton :to="shell.selected.value" external target="_blank" label="Open Server directly" color="neutral" variant="outline" /></template>
        </div>
        <div
          v-if="checkingAddress"
          class="flex h-full flex-col items-center justify-center gap-3 text-muted"
        >
          <UIcon name="i-ph-circle-notch" class="size-6 animate-spin" />
          <p class="text-sm">
            Opening {{ checkingAddress.replace(/^https?:\/\//, '') }}…
          </p>
        </div>
        <div
          v-else-if="showHome"
          class="absolute inset-0 overflow-y-auto bg-default"
        >
          <ShellServers />
        </div>
        <div
          v-else-if="showCreate || !shell.selected.value"
          class="absolute inset-0 overflow-y-auto bg-default"
        >
          <ServerCreate />
        </div>
        <UAlert
          v-else-if="error"
          class="absolute bottom-4 left-4 right-4"
          color="error"
          :description="error"
          closable
          @update:open="error = ''"
        />
      </section>
    </div>
  </main>
</template>

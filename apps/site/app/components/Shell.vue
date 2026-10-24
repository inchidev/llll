<script setup lang="ts">
import CommunityRail from '../../../../packages/client-ui/CommunityRail.vue'
import ServerAvatar from '../../../../packages/client-ui/ServerAvatar.vue'
import { SERVER_UNREACHABLE } from '../composables/useShell'
import { normalizeRoutePath } from '../utils/shell-route'
import { readDeploymentClaim } from '../../../../shared/deploy-handoff'

const shell = useShell()
const route = useRoute()
const ownOrigin = ref('')
const error = shell.error
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
const serversOpen = ref(false)
const activeServer = computed(() => shell.servers.value.find(item => item.origin === shell.selected.value))
function openServer(origin: string, id: string) {
  const server = shell.servers.value.find(
    (item) => item.origin === origin,
  )
  if (server) {
    serversOpen.value = false
    shell.open(server, id)
  }
}
function connect() {
  serversOpen.value = false
  shell.selected.value = ''
  void navigateTo('/create')
}
function home(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  serversOpen.value = false
  shell.selected.value = ''
  void navigateTo('/servers')
}
const showCreate = computed(() => path.value === '/create')
const showHome = computed(() => path.value === '/servers')
const showNavigation = computed(() => showCreate.value || showHome.value)
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
    serversOpen.value = false
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
    <div class="hidden shrink-0 md:block">
      <CommunityRail
        :groups="shell.groups.value"
        home-href="/servers"
        home-label="My servers"
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
      <header class="flex shrink-0 items-center gap-2 border-b border-default px-2 pt-[env(safe-area-inset-top)] md:hidden">
        <USlideover v-model:open="serversOpen" side="left" title="My servers" description="Saved on this device" :ui="{ content: 'max-w-[min(320px,100vw)]', body: 'p-3' }">
          <UButton icon="i-ph-squares-four" color="neutral" variant="ghost" class="size-11 shrink-0 justify-center" aria-label="Open server menu" />
          <template #body>
            <nav aria-label="Servers" class="space-y-2">
              <UButton to="/servers" label="My servers" icon="i-ph-house" color="neutral" variant="ghost" block class="min-h-11 justify-start" @click="home" />
              <UButton v-for="server in shell.servers.value" :key="server.origin" color="neutral" :variant="server.origin === shell.selected.value && !showNavigation ? 'soft' : 'ghost'" block class="min-h-12 justify-start" :aria-current="server.origin === shell.selected.value && !showNavigation ? 'page' : undefined" @click="openServer(server.origin, server.id)">
                <ServerAvatar :name="server.name" :icon-url="server.iconUrl" class="size-9 shrink-0 rounded-xl bg-accented" />
                <span class="min-w-0 flex-1 truncate text-start">{{ server.name }}</span>
                <span v-if="server.unread" :aria-label="`${server.unread} unread`" class="shrink-0 text-xs tabular-nums">{{ server.unread }}</span>
              </UButton>
              <UButton label="Add a server" icon="i-ph-plus" color="neutral" variant="outline" block class="min-h-11 justify-start" @click="connect" />
            </nav>
          </template>
        </USlideover>
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ showHome ? 'My servers' : showCreate ? 'Add a server' : activeServer?.name || 'L4' }}</span>
      </header>
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

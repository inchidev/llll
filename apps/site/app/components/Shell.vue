<script setup lang="ts">
import CommunityRail from '../../../../packages/client-ui/CommunityRail.vue'
import { SERVER_UNREACHABLE } from '../composables/useShell'
import { normalizeRoutePath } from '../utils/shell-route'
import { readDeploymentClaim } from '../../../../shared/deploy-handoff'

const shell = useShell()
const route = useRoute()
const ownOrigin = ref('')
const error = shell.error
const path = computed(() => normalizeRoutePath(route.path))
const queryOrigin = computed(() => {
  const value = route.query.server
  return typeof value === 'string' ? value : ''
})
const queryClaim = computed(() => readDeploymentClaim(route.hash))
const checkingAddress = ref('')
function openServer(origin: string, id: string) {
  const server = shell.servers.value.find(
    (item) => item.origin === origin,
  )
  if (server) shell.open(server, id)
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
onMounted(async () => {
  ownOrigin.value = location.origin
  shell.initialize()
  if (showNavigation.value) shell.selected.value = ''
  if (showCreate.value && queryOrigin.value) await handleQuery(queryOrigin.value, queryClaim.value)
  else if (route.params.serverId) await mountServer()
})
watch(
  () => route.fullPath,
  async () => {
    if (showNavigation.value) shell.selected.value = ''
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
    <section class="relative min-w-0 flex-1">
      <iframe
        v-for="origin in shell.loaded.value"
        v-show="shell.selected.value === origin && !showNavigation"
        :key="origin"
        :ref="(element) => selectFrame(element, origin)"
        :src="shell.frameSrc(origin, ownOrigin)"
        :title="`${shell.servers.value.find((i) => i.origin === origin)?.name || 'L4'} server`"
        class="absolute inset-0 h-full w-full border-0"
        allow="camera; microphone; display-capture; fullscreen; clipboard-write"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        referrerpolicy="no-referrer"
      />
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
  </main>
</template>

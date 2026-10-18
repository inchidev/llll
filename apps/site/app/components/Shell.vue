<script setup lang="ts">
import CommunityRail from '../../../../packages/client-ui/CommunityRail.vue'
import { SERVER_UNREACHABLE } from '../composables/useShell'
import { normalizeRoutePath } from '../utils/shell-route'

const shell = useShell()
const route = useRoute()
const ownOrigin = ref('')
const error = shell.error
const path = computed(() => normalizeRoutePath(route.path))
const queryOrigin = computed(() => {
  const value = route.query.server
  return typeof value === 'string' ? value : ''
})
const queryClaim = computed(() =>
  typeof route.query.claim === 'string' ? route.query.claim : undefined,
)
const checkingAddress = ref('')
async function openGroup(origin: string) {
  const installation = shell.servers.value.find(
    (item) => item.origin === origin,
  )
  if (installation) {
    await shell.open(installation)
    await navigateTo('/open')
  }
}
function openServer(origin: string, id: string) {
  const installation = shell.servers.value.find(
    (item) => item.origin === origin,
  )
  if (installation) shell.open(installation, id)
}
function connect() {
  shell.selected.value = ''
  void navigateTo('/open')
}
const showDeploy = computed(() => path.value === '/deploy')
/** The shell survives route changes as a v-show'd component, and its connect-on-mount check cannot run again.
 * When the deploy completion screen or a saved Server link navigates to /open?server=…,
 * connect here (with one bounded retry: a freshly deployed Server may not answer right away). */
let lastAutoOrigin = ''
async function connectQuery(
  origin: string,
  claim: string | undefined,
  attempt = 0,
) {
  try {
    const installation = await shell.connect(origin, claim)
    error.value = ''
    return installation
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Could not connect'
    if (!attempt && message === SERVER_UNREACHABLE) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 4000))
      return connectQuery(origin, claim, 1)
    }
    error.value = message
    // Keep the failed address in the form so a retry is one click on Open.
    shell.address.value = origin
  }
}
async function handleQuery(queryOrigin: string, claim: string | undefined) {
  if (queryOrigin === lastAutoOrigin) return
  lastAutoOrigin = queryOrigin
  if (!queryOrigin) return
  checkingAddress.value = queryOrigin
  const installation = await connectQuery(queryOrigin, claim).finally(() => {
    checkingAddress.value = ''
  })
  // Only after a successful connect may the one-time claim leave the address bar.
  if (installation && route.query.claim)
    history.replaceState(history.state, '', '/open')
}
function selectFrame(element: unknown, origin: string) {
  if (element instanceof HTMLIFrameElement) shell.frames.value[origin] = element
}
onMounted(async () => {
  ownOrigin.value = location.origin
  shell.initialize()
  if (queryOrigin.value) await handleQuery(queryOrigin.value, queryClaim.value)
  else if (route.params.serverId) await mountServer()
})
watch(
  () => route.fullPath,
  async () => {
    if (path.value === '/open' && queryOrigin.value)
      await handleQuery(queryOrigin.value, queryClaim.value)
    else if (route.params.serverId) await mountServer()
  },
)
async function mountServer() {
  try {
    await shell.resolveServer()
  } catch {
    error.value = 'This server is unavailable. Open its server directly.'
  }
}
</script>

<template>
  <main class="flex h-dvh overflow-hidden bg-default">
    <CommunityRail
      :groups="shell.groups.value"
      :active-origin="shell.selected.value"
      :active-server-id="
        typeof route.params.serverId === 'string'
          ? route.params.serverId
          : undefined
      "
      @server="openServer"
      @group="openGroup"
      @connections="connect"
      @connect="connect"
      @install="navigateTo('/deploy')"
    />
    <section class="relative min-w-0 flex-1">
      <iframe
        v-for="origin in shell.loaded.value"
        v-show="shell.selected.value === origin && !showDeploy"
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
        v-else-if="showDeploy || !shell.selected.value"
        class="absolute inset-0 overflow-y-auto bg-default"
      >
        <ServerDeploy v-if="showDeploy" />
        <UContainer v-else class="max-w-2xl py-10 sm:py-16">
          <h1 class="text-2xl font-semibold">Connect a server</h1>
          <p class="mt-3 text-muted">
            Enter the address of the L4 you want to join. You’ll sign in there.
          </p>
          <form
            class="mt-8 max-w-md space-y-4"
            @submit.prevent="shell.submitAddress"
          >
            <UFormField label="Address"
              ><UInput
                v-model="shell.address.value"
                placeholder="chat.example.com"
                autocomplete="url"
                required
                class="w-full"
            /></UFormField>
            <UButton
              type="submit"
              label="Open"
              :loading="shell.busy.value"
              block
            />
          </form>
          <UAlert
            v-if="error"
            class="mt-4"
            color="error"
            :description="error"
          />
          <ul v-if="shell.servers.value.length" class="mt-8 space-y-2">
            <li
              v-for="installation in shell.servers.value"
              :key="installation.origin"
            >
              <UButton
                :label="installation.name"
                color="neutral"
                variant="outline"
                @click="openGroup(installation.origin)"
              />
            </li>
          </ul>
        </UContainer>
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

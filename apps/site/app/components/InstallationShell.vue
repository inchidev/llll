<script setup lang="ts">
import { INSTALLATION_UNREACHABLE } from '../composables/useShell'
import { normalizeRoutePath } from '../utils/shell-route'

const shell = useShell()
const route = useRoute()
const ownOrigin = ref('')
const error = shell.error
const path = computed(() => normalizeRoutePath(route.path))
const queryOrigin = computed(() => typeof route.query.installation === 'string' ? route.query.installation : '')
const queryClaim = computed(() => typeof route.query.claim === 'string' ? route.query.claim : undefined)
const checkingAddress = ref('')
const showDeploy = computed(() => path.value === '/deploy')
/** The shell survives route changes as a v-show'd component, and its connect-on-mount check cannot run again.
 * When the deploy completion screen or a remembered-installation link navigates to /open?installation=…,
 * connect here (with one bounded retry: a freshly deployed installation may not answer right away). */
let lastAutoOrigin = ''
async function connectQuery(origin: string, claim: string | undefined, attempt = 0) {
  try { const installation = await shell.connect(origin, claim); error.value = ''; return installation }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Could not connect'
    if (!attempt && message === INSTALLATION_UNREACHABLE) { await new Promise(resolveTimer => setTimeout(resolveTimer, 4000)); return connectQuery(origin, claim, 1) }
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
  const installation = await connectQuery(queryOrigin, claim).finally(() => { checkingAddress.value = '' })
  // Only after a successful connect may the one-time claim leave the address bar.
  if (installation && route.query.claim) history.replaceState(history.state, '', '/open')
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
watch(() => route.fullPath, async () => {
  if (path.value === '/open' && queryOrigin.value) await handleQuery(queryOrigin.value, queryClaim.value)
  else if (route.params.serverId) await mountServer()
})
async function mountServer() {
  try { await shell.resolveServer() } catch { error.value = 'This server is unavailable. Open its installation directly.' }
}
</script>

<template>
  <main class="flex h-dvh overflow-hidden bg-default">
    <nav aria-label="Installations and servers" class="shell-rail flex w-[86px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-default bg-elevated px-2 py-3">
      <NuxtLink to="/open" aria-label="L4 connections" title="Your connections" class="mx-auto flex size-11 items-center justify-center text-highlighted"><BrandMark class="size-7" /></NuxtLink>

      <section v-for="installation in shell.installations.value" :key="installation.origin" :aria-label="installation.name" class="relative w-full flex flex-col gap-2">
        <button :aria-label="`Toggle ${installation.name}`" :aria-expanded="!installation.collapsed" class="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left text-muted hover:bg-accented hover:text-highlighted" title="Toggle this installation's servers" @click="installation.collapsed = !installation.collapsed; shell.persist()">
          <UIcon name="i-ph-caret-down" class="size-3 shrink-0 transition-transform" :class="installation.collapsed ? '' : '-rotate-90'" />
          <span class="truncate text-[10px] font-semibold uppercase tracking-wide">{{ installation.name }}</span>
        </button>
        <!-- Grouped: a collapsed header shows only the name; expanded servers sit below. -->
        <div v-if="!installation.collapsed" class="flex w-full flex-col items-center gap-2">
          <button v-for="server in installation.servers" :key="server.id" :aria-label="`${server.name} on ${installation.name}`" :aria-current="route.params.serverId === server.id ? 'page' : undefined" :title="server.name" class="relative flex size-11 shrink-0 items-center justify-center rounded-xl bg-accented text-sm font-semibold hover:bg-inverted hover:text-inverted" :class="route.params.serverId === server.id ? 'ring-2 ring-primary' : ''" @click="shell.open(installation, server.id)">{{ server.name.slice(0, 2).toUpperCase() }}<span v-if="server.unread" class="absolute -bottom-1 -right-1 rounded bg-primary px-1 text-[10px] text-inverted">{{ server.unread }}</span></button>
          <button v-if="!installation.servers.length" :aria-label="`Sign in to ${installation.name}`" class="flex size-11 items-center justify-center rounded-xl border border-default text-muted" @click="shell.openOwner(installation)"><UIcon name="i-ph-sign-in" class="size-5" /></button>
        </div>
      </section>

      <div class="w-full">
        <button aria-label="Add an installation" title="Add an installation you already host" class="mx-auto flex flex-col items-center gap-0.5 rounded-xl px-2 py-1 text-muted hover:bg-accented hover:text-highlighted" @click="shell.selected.value = ''; navigateTo('/open')">
          <UIcon name="i-ph-plus" class="size-5" />
          <span class="text-[10px] leading-none">Add</span>
        </button>
      </div>

      <NuxtLink to="/deploy" aria-label="Deploy L4" title="Install a new L4 on Cloudflare" class="mx-auto mt-auto flex flex-col items-center gap-0.5 rounded-xl px-2 py-1 text-muted hover:bg-accented hover:text-highlighted">
        <UIcon name="i-ph-cloud-arrow-up" class="size-5" />
        <span class="text-[10px] leading-none">Deploy</span>
      </NuxtLink>
    </nav>
    <section class="relative min-w-0 flex-1">
      <iframe v-for="origin in shell.loaded.value" v-show="shell.selected.value === origin" :key="origin" :ref="element => selectFrame(element, origin)" :src="shell.frameSrc(origin, ownOrigin)" :title="`${shell.installations.value.find(i => i.origin === origin)?.name || 'L4'} installation`" class="absolute inset-0 h-full w-full border-0" allow="camera; microphone; display-capture; fullscreen; clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerpolicy="no-referrer" />
      <div v-if="checkingAddress" class="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <UIcon name="i-ph-circle-notch" class="size-6 animate-spin" />
        <p class="text-sm">Opening {{ checkingAddress.replace(/^https?:\/\//, '') }}…</p>
      </div>
      <!-- One screen for both entry points (Add and Deploy): connect an existing installation by
           address, or create a new one — the deploy component carries the address form too. -->
      <div v-else-if="showDeploy || !shell.selected.value" class="absolute inset-0 overflow-y-auto bg-default">
        <InstallationDeploy />
      </div>
      <UAlert v-else-if="error" class="absolute bottom-4 left-4 right-4" color="error" :description="error" closable @update:open="error = ''" />
    </section>
  </main>
</template>

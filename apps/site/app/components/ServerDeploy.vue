<script setup lang="ts">
import { z } from 'zod'
import { deploymentShellUrl } from '../../../../shared/deploy-handoff'
import { readDeployedServers, recordDeployedServer, type DeployedServer } from '../../../../shared/deploy-recall'
import ServerAvatar from '../../../../packages/client-ui/ServerAvatar.vue'

const phases = ['Configure your Server', 'Start deployment', 'Wait for Cloudflare verification', 'Ready']
type Deployment = { origin: string; name: string; accountId: string; version?: string | null; claim?: string; iconUrl?: string | null }
const shell = useShell()
const route = useRoute()
const router = useRouter()
type SessionUpdate = {
  origin: string; accountId: string; workerName: string; jobId: string
  installedVersion: string; targetVersion: string
  phase: 'release' | 'backup' | 'deploy' | 'verify' | 'done'; done: boolean
  deploymentStarted: boolean
  backup?: { sizeBytes: number; verified: boolean; createdAt: string } | null
  error?: string | null
}
type SessionUpdateRequest = { origin: string; accountId: string; workerName: string; jobId: string }
type Session = {
  authorized: boolean; accounts: { id: string; name: string }[]; accountId?: string
  sessionExpiresAt: number; grantExpiresAt?: number; step?: number; completed?: boolean
  name?: string; ownerEmail?: string; version?: string; error?: string; origin?: string; claim?: string
  deployments?: Deployment[]
  updateRequest?: SessionUpdateRequest
  update?: SessionUpdate
}
const updateTarget = computed<SessionUpdateRequest | null>(() => {
  const origin = String(route.query?.server || '')
  const jobId = String(route.query?.update || '')
  const accountId = String(route.query?.account || '')
  const workerName = String(route.query?.worker || '')
  if (!origin || !jobId || !/^[0-9a-f]{32}$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) return null
  return { origin, accountId, workerName, jobId }
})
const resumeUpdate = computed(() => route.query?.resume === 'update')
const updateRequest = computed(() => session.value?.updateRequest || updateTarget.value)
const update = computed(() => session.value?.update)
const updateMode = computed(() => Boolean(updateTarget.value || resumeUpdate.value))
const updating = ref(false)
const updateError = ref('')
const updatePhases = ['Verify the published release', 'Back up and verify Server data', 'Upload the new release', 'Wait for Cloudflare verification', 'Update complete']
const updatePhase = computed(() => ({ release: 0, backup: 1, deploy: 2, verify: 3, done: 4 })[update.value?.phase || 'release'])
const name = ref('My L4')
const ownerEmail = ref('')
const accountId = ref('')
const formSchema = z.object({
  accountId: z.string().min(1, 'Choose a Cloudflare account'),
  name: z.string().trim().min(1, 'Enter a Server name').max(80),
  ownerEmail: z.email('Enter your admin email'),
  version: z.string().min(1, 'Choose a published release'),
})
const busy = ref(false)
const creating = ref(false)
const loading = ref(true)
const listing = ref(false)
const error = ref('')
const listError = ref('')
const config = ref<{ oauth: boolean } | null>(null)
const session = ref<Session | null>(null)
const versions = ref<{ version: string; published_at: string }[]>([])
const version = ref('')
const releasesError = ref('')
const remembered = ref<DeployedServer[]>([])
const inventory = ref<Deployment[]>([])
const inventoryLoaded = ref(false)
const now = ref(Date.now())
const sessionEnded = ref(false)
const copied = ref('')
async function copyAddress(origin: string) {
  try { await navigator.clipboard.writeText(origin); copied.value = origin }
  catch { /* The displayed address remains selectable. */ }
}
const pending = computed(() => session.value?.step !== undefined && !session.value.completed)
const connected = computed(() => Boolean(session.value?.authorized && now.value < session.value.sessionExpiresAt && now.value < (session.value.grantExpiresAt || 0)))
const expired = computed(() => sessionEnded.value || Boolean(session.value && (!session.value.authorized || now.value >= Math.min(session.value.sessionExpiresAt, session.value.grantExpiresAt || 0))))
const rows = computed(() => {
  const currentAppearance = (entry: Deployment | DeployedServer) => ({ ...entry, ...shell.metadata.value[entry.origin] })
  if (connected.value && inventoryLoaded.value) return inventory.value.map(currentAppearance)
  const saved = connected.value ? remembered.value.filter(item => item.accountId === accountId.value) : remembered.value
  const current = connected.value ? inventory.value : []
  return [...current, ...saved.filter(item => !current.some(server => server.origin === item.origin))].map(currentAppearance)
})
const statuses = ref<Record<string, 'ready' | 'setup' | 'unavailable'>>({})
const checking = ref<Record<string, boolean>>({})
const statusLabel = (origin: string) => ({ ready: 'Ready', setup: 'Setup required', unavailable: 'Unavailable' })[statuses.value[origin] || 'unavailable']
const remaining = (expiresAt = 0) => `${Math.max(0, Math.ceil((expiresAt - now.value) / 60000))} min`
function claimFor(origin: string) {
  if (!session.value || now.value >= session.value.sessionExpiresAt) return undefined
  return session.value.origin === origin && session.value.completed
    ? session.value.claim
    : session.value.deployments?.find(item => item.origin === origin)?.claim
}
function openRoute(origin: string) {
  return deploymentShellUrl(origin, statuses.value[origin] === 'setup' ? claimFor(origin) : undefined)
}
function remember(entry: Deployment) {
  remembered.value = recordDeployedServer({ origin: entry.origin, name: entry.name, accountId: entry.accountId, version: entry.version, ...shell.metadata.value[entry.origin], completedAt: Date.now() })
}
async function refresh() {
  try {
    session.value = await $fetch<Session>('/api/deploy/session')
    sessionEnded.value = false
    const accounts = session.value.accounts
    if (!accounts.some(account => account.id === accountId.value))
      accountId.value = accounts.find(account => account.id === (session.value?.updateRequest?.accountId || session.value?.accountId))?.id || accounts[0]?.id || ''
    ownerEmail.value ||= session.value.ownerEmail || ''
    error.value = session.value.error || ''
    for (const entry of session.value.deployments || []) remember(entry)
    if (session.value.completed && session.value.origin && session.value.accountId)
      remember({ origin: session.value.origin, name: session.value.name || 'L4', accountId: session.value.accountId, version: session.value.version })
  } catch (cause) {
    const status = (cause as { status?: number }).status
    if ([401, 403].includes(status || 0)) { session.value = null; sessionEnded.value = remembered.value.length > 0 }
    else if (status !== 503) error.value = 'Could not load the Cloudflare connection. Try again.'
  }
}
let request = 0
const probes = new Set<AbortController>()
async function checkServer(origin: string) {
  const controller = new AbortController()
  checking.value[origin] = true
  probes.add(controller)
  const timer = setTimeout(() => controller.abort(), 7000)
  try {
    const data = await shell.readMetadata(origin, controller.signal)
    statuses.value[origin] = data.ready ? 'ready' : 'setup'
  } catch { statuses.value[origin] = 'unavailable' }
  finally { clearTimeout(timer); probes.delete(controller); checking.value[origin] = false }
}
async function checkRows() {
  const origins = rows.value.slice(0, 20).map(item => item.origin)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, origins.length) }, async () => {
    while (cursor < origins.length) await checkServer(origins[cursor++]!)
  }))
}
async function loadServers() {
  if (updateMode.value) { listing.value = false; return }
  const current = ++request
  inventory.value = []
  inventoryLoaded.value = false
  listError.value = ''
  if (!connected.value || !accountId.value) { listing.value = false; await checkRows(); return }
  listing.value = true
  const selected = accountId.value
  try {
    const data = await $fetch<{ servers: Deployment[] }>('/api/deploy/servers', { query: { accountId: selected } })
    if (current !== request || selected !== accountId.value || !connected.value) return
    inventory.value = data.servers
    inventoryLoaded.value = true
    for (const entry of data.servers) remember(entry)
  } catch (cause) {
    if (current !== request) return
    const status = (cause as { status?: number }).status
    if ([401, 403].includes(status || 0)) { sessionEnded.value = true; if (session.value) session.value.authorized = false }
    listError.value = 'Could not refresh your Servers. Reconnect Cloudflare or try again.'
  } finally {
    if (current === request) { listing.value = false; await checkRows() }
  }
}
watch(accountId, () => { if (!loading.value) void loadServers() })
async function deploy() {
  busy.value = true
  error.value = ''
  try {
    if (!pending.value) await $fetch('/api/deploy/start', { method: 'POST', body: { accountId: accountId.value, name: name.value, ownerEmail: ownerEmail.value, version: version.value } })
    await refresh()
    while (session.value && !session.value.completed) {
      await $fetch('/api/deploy/advance', { method: 'POST', timeout: 150000 })
      await refresh()
      if (!session.value?.completed) await new Promise(resolve => setTimeout(resolve, 3000))
    }
    creating.value = false
    await loadServers()
    if (session.value?.completed && session.value.origin)
      await navigateTo(deploymentShellUrl(session.value.origin, session.value.claim))
  } catch (cause) {
    error.value = (cause as { data?: { error?: { message?: string } } }).data?.error?.message || 'Deployment paused. Retry to resume the same Server.'
  } finally { busy.value = false }
}
async function prepareUpdate() {
  const target = updateTarget.value || (resumeUpdate.value ? session.value?.updateRequest : undefined)
  if (!target) return
  updateError.value = ''
  try {
    await $fetch('/api/deploy/update/prepare', { method: 'POST', body: target })
    await refresh()
  } catch (cause) {
    updateError.value = (cause as { data?: { error?: { message?: string } } }).data?.error?.message || 'The update request could not be loaded.'
  }
}
async function runUpdate() {
  if (updating.value) return
  updating.value = true
  updateError.value = ''
  try {
    await $fetch('/api/deploy/update/start', { method: 'POST' })
    await refresh()
    while (session.value?.update && !session.value.update.done) {
      await $fetch('/api/deploy/update/advance', { method: 'POST' })
      await refresh()
      if (!session.value?.update?.done) await new Promise(resolve => setTimeout(resolve, 3000))
    }
    if (session.value?.update?.done) await loadServers()
  } catch (cause) {
    updateError.value = (cause as { data?: { error?: { message?: string } } }).data?.error?.message || 'The update paused. Retry to resume it.'
    await refresh()
  } finally { updating.value = false }
}
async function leaveUpdate() {
  try { await $fetch('/api/deploy/update/forget', { method: 'POST' }) } catch { /* The page still leaves update mode locally. */ }
  updateError.value = ''
  await router.replace({ path: '/create', query: { tab: 'cloudflare' } })
  await refresh()
  void loadServers()
}
let clock: ReturnType<typeof setInterval> | undefined
onUnmounted(() => { clearInterval(clock); for (const probe of probes) probe.abort(); request++ })
onMounted(async () => {
  remembered.value = readDeployedServers()
  try { config.value = await $fetch('/api/deploy/config') }
  catch { error.value = 'Could not load Cloudflare configuration. Try again.' }
  await refresh()
  if (updateTarget.value || resumeUpdate.value) await prepareUpdate()
  loading.value = false
  clock = setInterval(() => { now.value = Date.now() }, 1000)
  if (!updateMode.value) void loadServers()
  try {
    const data = await $fetch<{ releases: { version: string; published_at: string }[] }>('/api/deploy/releases')
    versions.value = data.releases
    version.value = data.releases[0]?.version || ''
  } catch { releasesError.value = 'Could not load releases. Enter a published release version.' }
})
</script>

<template>
  <section class="space-y-6">
    <p class="text-sm leading-6 text-muted">{{ updateMode ? 'Update a Server from a published release. Your Cloudflare account is billed directly, and the Server receives no account credential.' : 'Deploy to your Cloudflare account. Your Server owns its accounts and data.' }}</p>
    <p v-if="loading" role="status" class="text-sm text-muted">Checking Cloudflare connection…</p>
    <section v-else class="space-y-4 rounded-lg border border-default p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="font-medium">{{ connected ? 'Cloudflare connected' : expired ? 'Cloudflare connection ended' : 'Connect Cloudflare' }}</p>
        <UButton v-if="!connected" :to="pending ? '/api/deploy/oauth?resume=1' : '/api/deploy/oauth'" external :label="expired || pending ? 'Reconnect Cloudflare' : 'Connect Cloudflare'" icon="i-ph-cloud" :disabled="!config?.oauth" size="sm" />
      </div>
      <template v-if="connected && session">
        <UFormField label="Cloudflare account"><USelect v-model="accountId" :items="session.accounts.map(account => ({ label: account.name, value: account.id }))" :disabled="pending || busy || updating" class="w-full" /></UFormField>
        <p class="text-xs leading-5 text-muted">Cloudflare access: {{ remaining(session.grantExpiresAt) }} · Installer session: {{ remaining(session.sessionExpiresAt) }}.<br>Your Servers keep running when this connection ends.</p>
      </template>
      <p v-else class="text-sm text-muted">{{ expired ? 'Reconnect to refresh the account list or create another Server. Saved Servers remain available on this device.' : 'Authorize L4 to find your Servers and create new ones in your Cloudflare account.' }}</p>
      <p v-if="config && !config.oauth" class="text-sm text-muted">Cloudflare connection is unavailable here. <a href="https://github.com/inchidev/llll/blob/main/docs/deployment.md" class="underline">Manual setup</a> is available.</p>
    </section>

    <template v-if="!updateMode">
    <section class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-xl font-semibold tracking-tight">{{ connected ? 'Your Servers' : 'Saved on this device' }}</h2>
        <UButton v-if="connected" label="Refresh Servers" icon="i-ph-arrow-clockwise" color="neutral" variant="ghost" size="sm" :loading="listing" :disabled="busy" @click="loadServers" />
      </div>
      <p v-if="listing && !rows.length" role="status" class="text-sm text-muted">Finding L4 Servers…</p>
      <p v-else-if="!rows.length && !listError" class="text-sm text-muted">{{ connected ? 'No L4 Servers found in this account yet.' : 'Servers you open here will stay in this list.' }}</p>
      <ul v-else-if="rows.length" class="space-y-3">
        <li v-for="entry in rows" :key="entry.origin" class="min-w-0 space-y-3 rounded-lg border border-default p-4">
          <div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <ServerAvatar :name="entry.name || 'L4 Server'" :icon-url="entry.iconUrl" class="size-10 rounded-xl bg-accented" />
            <div class="min-w-0 flex-1">
              <p class="break-words font-medium text-highlighted">{{ entry.name || 'L4 Server' }}</p>
              <p class="break-all text-xs leading-5 text-muted">{{ entry.origin.replace(/^https?:\/\//, '') }}</p>
              <p v-if="entry.version" class="text-xs text-muted">{{ entry.version }}</p>
            </div>
            <UBadge :color="statuses[entry.origin] === 'ready' ? 'success' : statuses[entry.origin] === 'setup' ? 'warning' : 'neutral'" variant="subtle">{{ checking[entry.origin] ? 'Checking…' : statuses[entry.origin] ? statusLabel(entry.origin) : 'Not checked' }}</UBadge>
          </div>
          <div class="flex flex-wrap gap-2">
            <UButton v-if="statuses[entry.origin] === 'setup' && claimFor(entry.origin)" :to="openRoute(entry.origin)" label="Continue owner setup" size="sm" />
            <UButton v-else :to="openRoute(entry.origin)" label="Open Server" size="sm" color="neutral" variant="outline" />
            <UButton :to="statuses[entry.origin] === 'setup' && claimFor(entry.origin) || entry.origin" external label="Open directly" icon="i-ph-arrow-square-out" size="sm" color="neutral" variant="ghost" />
            <UButton :label="copied === entry.origin ? 'Copied' : 'Copy address'" size="sm" color="neutral" variant="ghost" @click="copyAddress(entry.origin)" />
          </div>
        </li>
      </ul>
      <UAlert v-if="listError" color="warning" :description="listError" />
    </section>

    <UButton v-if="!creating && !pending" :label="rows.length ? 'Create another Server' : 'Create a Server'" icon="i-ph-plus" :disabled="!connected" @click="creating = true" />
    <UForm v-if="creating || pending" :schema="pending ? undefined : formSchema" :state="{ accountId, name, ownerEmail, version }" class="space-y-5 border-t border-default pt-6" @submit="deploy">
      <h2 class="text-xl font-semibold">{{ pending ? 'Server deployment' : 'Create a Server' }}</h2>
      <template v-if="!pending">
        <UFormField name="ownerEmail" label="Your admin email" description="Choose your local owner password after deployment."><UInput v-model="ownerEmail" name="email" autocomplete="email" type="email" required class="w-full" /></UFormField>
        <UFormField name="name" label="Server name"><UInput v-model="name" class="w-full" maxlength="80" /></UFormField>
        <UFormField name="version" label="Release version">
          <USelect v-if="versions.length" v-model="version" :items="versions.map(release => ({ label: release.version, value: release.version }))" class="w-full" />
          <UInput v-else v-model="version" placeholder="v0.2.0-alpha.3" class="w-full" />
        </UFormField>
        <p v-if="releasesError" class="text-sm text-muted">{{ releasesError }}</p>
        <p class="text-sm text-muted">Your Server starts on workers.dev. Cloudflare bills usage directly. Enable R2 in your account first; no Git integration or Workers Builds token is required.</p>
      </template>
      <ol v-else class="space-y-3"><li v-for="(phase, index) in phases" :key="phase" class="flex items-center gap-3" :class="index > (session?.step || 0) ? 'text-dimmed' : 'text-highlighted'"><UIcon :name="index < (session?.step || 0) ? 'i-ph-check-circle' : 'i-ph-circle'" class="size-5" />{{ phase }}</li></ol>
      <p v-if="pending && session?.version" class="text-sm text-muted">Release {{ session.version }}</p>
      <div class="flex flex-wrap gap-2">
        <UButton type="submit" :label="pending ? 'Resume deployment' : 'Deploy Server'" :loading="busy" :disabled="!connected || (!pending && !version)" />
        <UButton v-if="!pending" label="Cancel" color="neutral" variant="ghost" :disabled="busy" @click="creating = false" />
      </div>
    </UForm>
    </template>
    <template v-else>
      <section class="space-y-4 rounded-lg border border-default p-4">
        <template v-if="update">
          <div>
            <p class="text-xs uppercase tracking-wide text-muted">Server update</p>
            <h2 class="break-all text-xl font-semibold tracking-tight">{{ update.origin.replace(/^https?:\/\//, '') }}</h2>
            <p class="text-sm text-muted">L4 {{ update.installedVersion }} → L4 {{ update.targetVersion }}</p>
          </div>
          <ol class="space-y-3">
            <li v-for="(phase, index) in updatePhases" :key="phase" class="flex items-center gap-3" :class="index > updatePhase ? 'text-dimmed' : 'text-highlighted'">
              <UIcon :name="index < updatePhase || update.done ? 'i-ph-check-circle' : index === updatePhase ? 'i-ph-circle-notch' : 'i-ph-circle'" class="size-5" :class="index === updatePhase && !update.done ? 'animate-spin' : ''" />{{ phase }}
            </li>
          </ol>
          <p v-if="update.backup" class="text-sm text-muted">{{ update.backup.verified ? 'Backup verified' : 'Backup uploaded' }} · {{ Math.max(1, Math.ceil(update.backup.sizeBytes / 1024)) }} KB</p>
          <p v-if="update.deploymentStarted" class="text-sm text-muted">The new release has been uploaded. Keep this page open while Cloudflare verifies the Server.</p>
          <div class="flex flex-wrap gap-2">
            <UButton v-if="!update.done" label="Back up and update" icon="i-ph-cloud-arrow-up" :loading="updating" :disabled="!connected || updating" @click="runUpdate" />
            <UButton v-else :to="update.origin" external label="Open your Server" icon="i-ph-arrow-square-out" />
          </div>
        </template>
        <template v-else-if="updateRequest">
          <h2 class="break-all text-xl font-semibold tracking-tight">Update {{ updateRequest.origin.replace(/^https?:\/\//, '') }}</h2>
          <p class="text-sm text-muted">Connect Cloudflare to load the update request saved on this Server.</p>
          <UButton v-if="connected" label="Load update" :loading="loading" @click="prepareUpdate" />
          <p v-else class="text-sm text-muted">Use the Cloudflare connection above, then return here.</p>
        </template>
        <template v-else>
          <h2 class="text-xl font-semibold tracking-tight">Update not loaded</h2>
          <p class="text-sm text-muted">Reopen the update from your Server’s Settings. This browser has no saved update request.</p>
        </template>
        <UButton v-if="!updating" label="Add a server instead" color="neutral" variant="link" @click="leaveUpdate" />
      </section>
      <UAlert v-if="update?.error || updateError" color="error" :description="update?.error || updateError" />
    </template>
    <UAlert v-if="error" color="error" :description="error" />
  </section>
</template>

<script setup lang="ts">
import type { InstanceDiscovery, InstanceServer } from '~~/shared/instance'

definePageMeta({ layout: 'default' })
const connections = useInstances()
const route = useRoute()
const router = useRouter()
const address = ref('')
const connecting = computed(() => route.query.connect === '1')
async function connectAddress() {
  await inspect(address.value)
  await router.replace({ path: '/connections', query: { instance: discovery.value!.origin } })
}
const toast = useToast()
const embedded = import.meta.client && window.parent !== window
const popup = useInstancePopup()
const discovery = ref<(InstanceDiscovery & { ready?: boolean }) | null>(null)
const ownOrigin = import.meta.client ? location.origin : ''
const owner = ref(false)
const authBusy = ref(false)
const serverBusy = ref(false)
const inviteBusy = ref(false)
const settingsBusy = ref(false)
const backupBusy = ref(false)
const error = ref('')
const activeTab = ref<'servers' | 'settings' | 'account'>('account')
const mode = ref<'login' | 'signup' | 'setup'>('login')
const recoveryCode = ref('')
const recovering = ref(false)
const form = reactive({ name: '', email: '', password: '', token: '' })
const serverName = ref('')
const serverId = computed(() => serverName.value.trim())
const selected = computed(() => connections.installations.value.find(item => item.origin === discovery.value?.origin))
const settings = reactive({ telegramBotToken: '', telegramTrustedBotId: '', telegramClientId: '', telegramClientSecret: '', cloudflareAccountId: '', cloudflareApiToken: '' })
const registration = reactive({ id: '', name: '', origin: '', key: '' })
const configured = ref<{ telegram: boolean; telegramOidc: boolean; cloudflare: boolean } | null>(null)
const invite = ref(typeof route.query.invite === 'string' ? route.query.invite : '')

async function withBusy(busyRef: { value: boolean }, action: () => Promise<void>) {
  busyRef.value = true
  error.value = ''
  try { await action() }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busyRef.value = false }
}
const runAuth = (action: () => Promise<void>) => withBusy(authBusy, action)
const runServer = (action: () => Promise<void>) => withBusy(serverBusy, action)
const runInvite = (action: () => Promise<void>) => withBusy(inviteBusy, action)
const runSettings = (action: () => Promise<void>) => withBusy(settingsBusy, action)
const runBackup = (action: () => Promise<void>) => withBusy(backupBusy, action)
async function run(action: () => Promise<void>) {
  error.value = ''
  try { await action() }
  catch (cause) { error.value = errorMessage(cause) }
}
function afterAuthState() {
  activeTab.value = owner.value && selected.value ? 'servers' : 'account'
}

async function inspect(addressValue = ownOrigin) {
  recoveryCode.value = ''
  configured.value = null
  for (const key of Object.keys(settings) as (keyof typeof settings)[]) settings[key] = ''
  const result = await connections.discover(addressValue)
  if (result.kind === 'client') throw new Error('Enter your installation address, such as sandbox.llll.gg')
  discovery.value = result
  owner.value = false
  mode.value = result.ready === false ? 'setup' : 'login'
  activeTab.value = 'account'
  if (result.kind === 'server') return
  try { owner.value = (await connections.refresh(result.origin))?.owner ?? false; afterAuthState() }
  catch { /* Sign-in is shown for an unconnected account. */ }
}

async function authenticate() {
  const target = discovery.value
  if (!target) return
  const finish = async () => {
    if (recovering.value) {
      await connections.request(target.origin, '/api/instance/recover', { method: 'POST', body: { email: form.email, code: form.token, password: form.password } })
      recovering.value = false
      form.password = ''; form.token = ''
      toast.add({ title: 'Password replaced. Sign in and save a new recovery key.' })
      return
    }
    const path = mode.value === 'setup' ? '/api/instance/setup' : mode.value === 'signup' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email'
    const result = await connections.request<{ redirect?: boolean; url?: string }>(target.origin, path, { method: 'POST', body: { ...form, inviteToken: invite.value || undefined, ...(route.query.sig ? { oauth_query: location.search.slice(1) } : {}) } })
    if (result.redirect && result.url) { location.assign(result.url); return }
    form.password = ''
    form.token = ''
    target.ready = true
    owner.value = (await connections.refresh(target.origin))?.owner ?? false
    if (invite.value) await join()
    resumeConnection()
    if (owner.value) configured.value = await connections.request(target.origin, '/api/instance/settings')
    activeTab.value = owner.value ? 'servers' : 'account'
  }
  await runAuth(finish)
}

function open(origin: string, id: string) {
  connections.select(origin, id)
  window.location.assign('/')
}

async function createServer() {
  if (!discovery.value) return
  await connections.request(discovery.value.origin, '/api/instance/servers', { method: 'POST', body: { name: serverName.value } })
  await connections.refresh(discovery.value.origin)
  serverName.value = ''
}

const probes = new Set<string>()
async function probeServerList() {
  const servers = selected.value?.servers || []
  for (const server of servers) if (server.status === 'provisioning' && !probes.has(server.id)) probeServer(server)
}

// Verify that a freshly deployed Server is reachable from the user's browser.
async function probeServer(server: InstanceServer) {
  if (!discovery.value || !import.meta.client) return
  probes.add(server.id)
  try {
    let lastFailure = 'Server health check could not complete from this browser'
    for (let attempt = 0; attempt < 45; attempt += 1) {
      const row = selected.value?.servers.find(item => item.id === server.id)
      if (!row || row.status !== 'provisioning' || !row.origin) return
      try {
        const response = await fetch(`${new URL(row.origin).origin}/api/setup/health`, { headers: { Accept: 'application/json' }, redirect: 'manual', cache: 'no-store' })
        const health = response.ok ? await response.json() as { ok?: boolean; migrated?: boolean; version?: string } : null
        if (!response.ok) lastFailure = `HTTP ${response.status}`
        else if (health?.ok && health.migrated && health.version === row.version) {
          await connections.request(discovery.value.origin, `/api/instance/servers/${server.id}/confirm`, { method: 'POST', body: { ok: true } })
          toast.add({ title: `${row.name} is ready` })
          return
        }
        else if (health?.ok === false) lastFailure = `Server is unhealthy (${health.migrated ? 'bindings' : 'migrations'})`
      }
      catch (cause) { lastFailure = errorMessage(cause) }
      await new Promise(resolve => setTimeout(resolve, 4000))
    }
    await connections.request(discovery.value.origin, `/api/instance/servers/${server.id}/confirm`, { method: 'POST', body: { ok: false, error: lastFailure } })
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally {
    probes.delete(server.id)
    if (discovery.value) await connections.refresh(discovery.value.origin).catch(() => {})
  }
}

watch(() => selected.value?.servers.map(server => [server.id, server.status].join(':')).join(','), () => probeServerList(), { immediate: true })

async function join() {
  if (!discovery.value || !invite.value) return
  await connections.request(discovery.value.origin, '/api/instance/join', { method: 'POST', body: { token: invite.value } })
  invite.value = ''
  await connections.refresh(discovery.value.origin)
  toast.add({ title: 'Server joined' })
}async function makeInvite(serverIdValue: string) {
  if (!discovery.value) return
  const response = await connections.request<{ invite: { url: string } }>(discovery.value.origin, `/api/instance/servers/${serverIdValue}/invites`, { method: 'POST', body: {} })
  await navigator.clipboard.writeText(response.invite.url)
  toast.add({ title: 'Invitation copied', description: 'The invitation expires in 24 hours.' })
}

function resumeConnection() {
  if (typeof route.query.return_to !== 'string') return
  const target = new URL(route.query.return_to, location.origin)
  if (target.origin === location.origin && target.pathname === '/api/auth/connection/authorize') location.assign(target.toString())
}

async function providerLogin(providerId: string, link = false) {
  if (!discovery.value) return
  const result = await connections.request<{ url: string }>(discovery.value.origin, link ? '/api/auth/link-social' : '/api/auth/sign-in/social', { method: 'POST', body: { provider: providerId, callbackURL: `${location.origin}${route.fullPath}` } })
  location.assign(result.url)
}

async function registerServer() {
  if (!discovery.value) return
  await connections.request(discovery.value.origin, '/api/instance/servers/register', { method: 'POST', body: { ...registration } })
  registration.key = ''
  await connections.refresh(discovery.value.origin)
  toast.add({ title: 'Server connected' })
}

async function saveSettings() {
  if (!discovery.value) return
  await connections.request(discovery.value.origin, '/api/instance/settings', { method: 'PUT', body: Object.fromEntries(Object.entries(settings).filter(([, value]) => value.trim())) })
  for (const key of Object.keys(settings) as (keyof typeof settings)[]) settings[key] = ''
  configured.value = await connections.request(discovery.value.origin, '/api/instance/settings')
  toast.add({ title: 'Instance settings saved' })
}

async function signOut(): Promise<void> {
  if (!discovery.value) return
  await connections.logout(discovery.value.origin)
  window.location.assign('/connections')
}

const tabItems = computed(() => [
  { label: 'Servers', value: 'servers' },
  ...(owner.value ? [{ label: 'Settings', value: 'settings' }] : []),
  { label: 'Account', value: 'account' },
] as { label: string; value: string }[])

onMounted(async () => {
  const callback = new URLSearchParams(location.hash.slice(1))
  if (window.opener && callback.has('llll_connection') && callback.get('installation') === location.origin) {
    window.opener.postMessage({ type: 'llll-local-login', code: callback.get('llll_connection'), state: callback.get('state') }, location.origin)
    history.replaceState(history.state, '', '/connections')
    window.close(); return
  }
  const connected = await connections.acceptBrowserConnection().catch(cause => { error.value = errorMessage(cause); return false })
  form.token = new URLSearchParams(location.hash.slice(1)).get('claim') || ''
  if (form.token) history.replaceState(null, '', `${location.pathname}${location.search}`)
  const local = connections.installations.value.find(item => item.origin === location.origin)
  const requestedOrigin = route.query.instance ?? route.query.installation
  const requested = typeof requestedOrigin === 'string' ? connections.installations.value.find(item => item.origin === requestedOrigin) : undefined
  const first = requested || (connected ? connections.installations.value.find(item => item.origin === connected) : undefined) || local || connections.installations.value[0]
  if (first) await run(() => inspect(first.origin))
  if (local?.userId) resumeConnection()
  if (owner.value && discovery.value) configured.value = await connections.request(discovery.value.origin, '/api/instance/settings')
})
</script>

<template>
  <main class="h-full overflow-y-auto bg-default px-5 py-10 sm:px-10">
    <div class="mx-auto max-w-2xl space-y-8">
      <UAlert v-if="error" color="error" :title="error" />
      <section v-if="connecting" class="py-3">
        <h1 class="text-2xl font-semibold">Connect an instance</h1>
        <p class="mt-3 text-muted">Enter the address of the L4 you want to join. You’ll sign in there.</p>
        <form class="mt-8 max-w-md space-y-4" @submit.prevent="runAuth(connectAddress)">
          <UFormField label="Address"><UInput v-model="address" placeholder="chat.example.com" autocomplete="url" required class="w-full" /></UFormField>
          <UButton type="submit" label="Open" :loading="authBusy" block />
        </form>
      </section>
      <section v-else-if="discovery" class="py-3">
        <div class="flex items-center justify-between gap-3"><div><h2 class="text-xl font-semibold">{{ discovery.name }}</h2><p class="mt-1 break-all text-sm text-muted">{{ discovery.origin }}</p></div></div>
        <template v-if="discovery.kind === 'installation'">
          <form v-if="!selected?.userId" class="mt-6 grid max-w-md gap-4" @submit.prevent="runAuth(authenticate)">
            <h3 class="font-medium">{{ mode === 'setup' ? 'Claim your instance' : mode === 'signup' ? 'Create an account here' : 'Sign in to this instance' }}</h3>
            <UButton v-if="discovery.origin !== ownOrigin && mode !== 'setup'" label="Continue on instance" icon="i-ph-arrow-square-out" color="neutral" variant="outline" @click="connections.connectInBrowser(discovery.origin)" />
            <UButton v-if="embedded" label="Sign in in a separate window" icon="i-ph-arrow-square-out" color="neutral" variant="outline" @click="runAuth(async () => { await popup.signIn(); await inspect(ownOrigin) })" />
            <UButton v-if="discovery.telegramOidc && discovery.origin === ownOrigin" label="Continue with Telegram" color="neutral" variant="outline" @click="runAuth(() => providerLogin('telegram'))" />
            <UFormField v-if="mode === 'setup' || recovering" :label="recovering ? 'Recovery key' : 'Private setup claim'"><UInput v-model="form.token" type="password" autocomplete="off" class="w-full" /></UFormField>
            <UFormField v-if="mode !== 'login'" label="Display name"><UInput v-model="form.name" autocomplete="name" class="w-full" /></UFormField>
            <UFormField label="Email"><UInput v-model="form.email" type="email" autocomplete="email" class="w-full" /></UFormField>
            <UFormField label="Password" :description="mode === 'login' ? undefined : 'Use at least 10 characters.'"><UInput v-model="form.password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" class="w-full" /></UFormField>
            <div class="flex flex-wrap items-center gap-3"><UButton type="submit" :label="recovering ? 'Recover account' : mode === 'setup' ? 'Create owner' : mode === 'signup' ? 'Create account' : 'Sign in'" :loading="authBusy" class="w-full justify-center sm:w-auto" /><UButton v-if="(discovery.registration || invite) && mode !== 'setup'" color="neutral" variant="link" :label="mode === 'login' ? 'Create account' : 'Sign in instead'" @click="mode = mode === 'login' ? 'signup' : 'login'" /></div>
            <UButton v-if="mode === 'login'" :label="recovering ? 'Back to sign in' : 'Use a recovery key'" color="neutral" variant="link" @click="recovering = !recovering" />
          </form>
          <template v-else>
            <UTabs :key="owner ? 'owner' : 'member'" v-model="activeTab" :items="tabItems" class="mt-2" />
            <div v-if="activeTab === 'servers'" class="mt-5">
              <div class="grid gap-3 sm:grid-cols-2">
                <article v-for="server in selected.servers" :key="server.id" class="rounded-xl border border-default bg-elevated/40 p-4"><div class="flex items-center justify-between"><h4 class="font-medium">{{ server.name }}</h4><UBadge v-if="server.status !== 'ready'" color="warning" variant="subtle">{{ server.status }}</UBadge></div><p v-if="server.status === 'provisioning'" class="mt-2 text-xs leading-5 text-toned">Deployed. Verifying server health…</p><p v-if="server.status === 'failed' && server.error" class="mt-2 text-xs leading-5 break-words text-toned">{{ server.error }}</p><div class="mt-4 flex gap-2"><UButton label="Open server" :disabled="server.status !== 'ready'" :color="server.status === 'ready' ? 'primary' : 'neutral'" size="sm" @click="open(discovery!.origin, server.id)" /><UButton v-if="owner && server.status === 'failed'" label="Retry" size="sm" color="neutral" variant="outline" @click="runServer(async () => { await connections.request(discovery!.origin, `/api/instance/servers/${server.id}/retry`, { method: 'POST', body: {} }); await connections.refresh(discovery!.origin) })" /><UButton v-if="server.ownerId === selected.userId && server.status === 'ready'" label="Invite" size="sm" color="neutral" variant="outline" @click="runServer(() => makeInvite(server.id))" /></div></article>
              </div>
              <p v-if="!selected.servers.length && !owner" class="mt-4 text-sm text-muted">Join a server using an invitation, or ask the instance owner to add you.</p>
              <div v-if="owner" class="mt-6">
                <form v-if="configured?.cloudflare !== false" class="flex items-end gap-2" @submit.prevent="runServer(createServer)"><UFormField label="Create a new server" description="Provisioned on the installation's connected Cloudflare account." class="min-w-0 flex-1"><UInput v-model="serverName" placeholder="My community" class="w-full" /></UFormField><UButton type="submit" label="Create" :loading="serverBusy" :disabled="!serverId" /></form>
                <template v-else>
                  <p class="text-sm text-muted">Connect a Cloudflare account to create servers here, or add one you already run.</p>
                  <UButton class="mt-3" label="Connect Cloudflare" color="neutral" variant="outline" size="sm" @click="activeTab = 'settings'" />
                </template>
              </div>
              <form class="mt-6 flex items-end gap-2" @submit.prevent="runInvite(join)"><UFormField label="Invitation code" class="min-w-0 flex-1"><UInput v-model="invite" placeholder="Paste an invitation code" class="w-full" /></UFormField><UButton type="submit" label="Join" color="neutral" variant="outline" :loading="inviteBusy" :disabled="!invite" /></form>
            </div>
            <div v-else-if="activeTab === 'settings' && owner" class="mt-5">
              <UButton label="Back up instance" color="neutral" variant="outline" size="sm" :loading="backupBusy" @click="runBackup(async () => { await connections.request(discovery!.origin, '/api/instance/backup', { method: 'POST', body: {} }); toast.add({ title: 'Instance backup saved' }) })" />
              <p class="mt-2 text-sm text-muted">Manage accounts and server provisioning for this instance. Saved secrets stay encrypted here.</p>
              <form class="mt-5 grid gap-4 sm:grid-cols-2" @submit.prevent="runSettings(saveSettings)">
                <UFormField label="Telegram bot token" :description="configured?.telegram ? 'Configured' : 'Optional · enable Mini App login'"><UInput v-model="settings.telegramBotToken" type="password" autocomplete="off" class="w-full" /></UFormField>
                <UFormField label="Trusted Mini App bot ID" description="Optional: accept Telegram-signed login from this bot without its token."><UInput v-model="settings.telegramTrustedBotId" class="w-full" /></UFormField>
                <UFormField label="Telegram client ID"><UInput v-model="settings.telegramClientId" autocomplete="off" class="w-full" /></UFormField>
                <UFormField label="Telegram client secret"><UInput v-model="settings.telegramClientSecret" type="password" autocomplete="off" class="w-full" /></UFormField>
                <UFormField label="Cloudflare account ID" :description="configured?.cloudflare ? 'Provisioning configured' : 'Enable automatic server creation'"><UInput v-model="settings.cloudflareAccountId" autocomplete="off" class="w-full" /></UFormField>
                <UFormField label="Cloudflare API token" description="Allows this installation to create and update servers. Saved tokens are never shown again."><UInput v-model="settings.cloudflareApiToken" type="password" autocomplete="off" class="w-full" /></UFormField>
                <div class="flex items-end"><UButton type="submit" label="Save settings" :loading="settingsBusy" /></div>
              </form>
              <details class="mt-6 border-t border-default pt-5"><summary class="cursor-pointer text-sm font-medium">Add an existing server</summary>
                <form class="mt-4 grid gap-4 sm:grid-cols-2" @submit.prevent="runSettings(registerServer)">
                  <UFormField label="Server ID"><UInput v-model="registration.id" placeholder="main" class="w-full" /></UFormField>
                  <UFormField label="Server name"><UInput v-model="registration.name" placeholder="My community" class="w-full" /></UFormField>
                  <UFormField label="Server origin"><UInput v-model="registration.origin" placeholder="https://server.example.com" class="w-full" /></UFormField>
                  <UFormField label="Pairing key"><UInput v-model="registration.key" type="password" autocomplete="off" class="w-full" /></UFormField>
                  <UButton type="submit" label="Register server" :loading="settingsBusy" />
                </form>
              </details>
            </div>
            <div v-else-if="activeTab === 'account'" class="mt-5 space-y-3">
              <div v-if="discovery.origin === ownOrigin && (discovery.identity || discovery.telegramOidc)"><UButton v-if="discovery.telegramOidc" label="Link Telegram" color="neutral" variant="outline" @click="runAuth(() => providerLogin('telegram', true))" /></div>
              <UButton label="Replace recovery key" color="neutral" variant="outline" size="sm" @click="runAuth(async () => { recoveryCode = (await connections.request<{ code: string }>(discovery!.origin, '/api/instance/recovery-key', { method: 'POST', body: {} })).code })" />
              <UAlert v-if="recoveryCode" color="warning" title="Save this private key now. It replaces your previous key and can only be used once." :description="recoveryCode" />
              <div class="pt-3"><UButton label="Sign out here" color="neutral" variant="link" size="sm" @click="runAuth(async () => signOut())" /></div>
            </div>
          </template>
        </template>
        <UButton v-else class="mt-6" label="Open server" @click="open(discovery.origin, discovery.id)" />
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import type { InstallationDiscovery } from '~~/shared/installation'

definePageMeta({ layout: 'default' })
const connections = useInstallations()
const route = useRoute()
const toast = useToast()
const address = ref('')
const discovery = ref<(InstallationDiscovery & { ready?: boolean }) | null>(null)
const ownOrigin = import.meta.client ? location.origin : ''
const owner = ref(false)
const busy = ref(false)
const error = ref('')
const mode = ref<'login' | 'signup' | 'setup'>('login')
const recoveryCode = ref('')
const recovering = ref(false)
const form = reactive({ name: '', email: '', password: '', token: '' })
const serverName = ref('')
const serverId = computed(() => serverName.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48))
const selected = computed(() => connections.installations.value.find(item => item.origin === discovery.value?.origin))
const settings = reactive({ telegramBotToken: '', telegramClientId: '', telegramClientSecret: '', cloudflareAccountId: '', cloudflareApiToken: '' })
const registration = reactive({ id: '', name: '', origin: '', key: '' })
const configured = ref<{ telegram: boolean; telegramOidc: boolean; cloudflare: boolean } | null>(null)
const invite = ref(typeof route.query.invite === 'string' ? route.query.invite : '')

async function run(action: () => Promise<void>) {
  busy.value = true
  error.value = ''
  try { await action() }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}

async function inspect(addressValue = address.value) {
  recoveryCode.value = ''
  configured.value = null
  for (const key of Object.keys(settings) as (keyof typeof settings)[]) settings[key] = ''
  const result = await connections.discover(addressValue)
  if (result.kind === 'client') throw new Error('Enter your installation address, such as sandbox.llll.gg')
  discovery.value = result
  address.value = result.origin
  owner.value = false
  mode.value = result.ready === false ? 'setup' : 'login'
  if (result.kind === 'server') return
  try { owner.value = (await connections.refresh(result.origin))?.owner ?? false }
  catch { /* Sign-in is shown for an unconnected account. */ }
}

async function authenticate() {
  if (!discovery.value) return
  if (recovering.value) {
    await connections.request(discovery.value.origin, '/api/installation/recover', { method: 'POST', body: { email: form.email, code: form.token, password: form.password } })
    recovering.value = false
    form.password = ''; form.token = ''
    toast.add({ title: 'Password replaced. Sign in and save a new recovery key.' })
    return
  }
  const path = mode.value === 'setup' ? '/api/installation/setup' : mode.value === 'signup' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email'
  const result = await connections.request<{ redirect?: boolean; url?: string }>(discovery.value.origin, path, { method: 'POST', body: { ...form, inviteToken: invite.value || undefined, ...(route.query.sig ? { oauth_query: location.search.slice(1) } : {}) } })
  if (result.redirect && result.url) { location.assign(result.url); return }
  form.password = ''
  form.token = ''
  discovery.value.ready = true
  owner.value = (await connections.refresh(discovery.value.origin))?.owner ?? false
  if (invite.value) await join()
  resumeConnection()
  if (owner.value) configured.value = await connections.request(discovery.value.origin, '/api/installation/settings')
}

function open(origin: string, id: string) {
  connections.select(origin, id)
  window.location.assign('/')
}

async function createServer() {
  if (!discovery.value) return
  await connections.request(discovery.value.origin, '/api/installation/servers', { method: 'POST', body: { id: serverId.value, name: serverName.value } })
  await connections.refresh(discovery.value.origin)
  serverName.value = ''
}

async function join() {
  if (!discovery.value || !invite.value) return
  await connections.request(discovery.value.origin, '/api/installation/join', { method: 'POST', body: { token: invite.value } })
  invite.value = ''
  await connections.refresh(discovery.value.origin)
  toast.add({ title: 'Server joined' })
}

async function makeInvite(serverIdValue: string) {
  if (!discovery.value) return
  const response = await connections.request<{ invite: { url: string } }>(discovery.value.origin, `/api/installation/servers/${serverIdValue}/invites`, { method: 'POST', body: {} })
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
  await connections.request(discovery.value.origin, '/api/installation/servers/register', { method: 'POST', body: { ...registration } })
  registration.key = ''
  await connections.refresh(discovery.value.origin)
  toast.add({ title: 'Server connected' })
}

async function saveSettings() {
  if (!discovery.value) return
  await connections.request(discovery.value.origin, '/api/installation/settings', { method: 'PUT', body: Object.fromEntries(Object.entries(settings).filter(([, value]) => value.trim())) })
  for (const key of Object.keys(settings) as (keyof typeof settings)[]) settings[key] = ''
  configured.value = await connections.request(discovery.value.origin, '/api/installation/settings')
  toast.add({ title: 'Installation settings saved' })
}

async function signOut() {
  if (!discovery.value) return
  await connections.logout(discovery.value.origin)
  window.location.assign('/connections')
}

onMounted(async () => {
  const connected = await connections.acceptBrowserConnection().catch(cause => { error.value = errorMessage(cause); return false })
  form.token = new URLSearchParams(location.hash.slice(1)).get('claim') || ''
  if (form.token) history.replaceState(null, '', `${location.pathname}${location.search}`)
  const local = connections.installations.value.find(item => item.origin === location.origin)
  const requested = typeof route.query.installation === 'string' ? connections.installations.value.find(item => item.origin === route.query.installation) : undefined
  const first = requested || (connected ? connections.installations.value.find(item => item.origin === connected) : undefined) || local || connections.installations.value[0]
  if (first) await run(() => inspect(first.origin))
  if (local?.userId) resumeConnection()
  if (owner.value && discovery.value) configured.value = await connections.request(discovery.value.origin, '/api/installation/settings')
})
</script>

<template>
  <main class="h-full overflow-y-auto bg-default px-5 py-10 sm:px-10">
    <div class="mx-auto max-w-3xl space-y-8">
      <header class="flex items-start justify-between gap-5">
        <div><p class="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary">L4 · llll.gg</p><h1 class="text-3xl font-semibold tracking-tight">Your places, together.</h1><p class="mt-3 max-w-xl text-muted">Connect installations you trust. Every server keeps its own conversations, files and permissions.</p></div>
        <UButton to="/deploy" label="Deploy your own" icon="i-ph-cloud-arrow-up" color="neutral" variant="outline" />
      </header>

      <section class="rounded-2xl border border-default bg-elevated/40 p-5">
        <h2 class="font-semibold">Connect an installation</h2>
        <form class="mt-4 flex gap-2" @submit.prevent="run(() => inspect())">
          <UInput v-model="address" type="url" placeholder="https://chat.example.com" aria-label="Installation address" class="min-w-0 flex-1" autocomplete="url" />
          <UButton type="submit" label="Connect" :loading="busy" :disabled="!address.trim()" />
        </form>
        <UAlert v-if="error" class="mt-4" color="error" :title="error" />
      </section>

      <section v-if="discovery" class="rounded-2xl border border-default p-5">
        <div class="flex items-center justify-between gap-3"><div><h2 class="text-xl font-semibold">{{ discovery.name }}</h2><p class="mt-1 text-sm text-muted">{{ discovery.origin }}</p></div><UBadge color="neutral" variant="subtle">{{ discovery.kind === 'server' ? 'Independent server' : 'Installation' }}</UBadge></div>
        <template v-if="discovery.kind === 'installation'">
          <form v-if="!selected?.userId" class="mt-6 grid max-w-md gap-4" @submit.prevent="run(authenticate)">
            <h3 class="font-medium">{{ mode === 'setup' ? 'Claim your installation' : mode === 'signup' ? 'Create an account here' : 'Sign in to this installation' }}</h3>
            <UButton v-if="discovery.origin !== ownOrigin && mode !== 'setup'" label="Continue on installation" icon="i-ph-arrow-square-out" color="neutral" variant="outline" @click="connections.connectInBrowser(discovery.origin)" />
            <UButton v-if="discovery.identity && discovery.origin === ownOrigin" label="Continue with L4 account" @click="run(() => providerLogin('llll'))" />
            <UButton v-if="discovery.telegramOidc && discovery.origin === ownOrigin" label="Continue with Telegram" color="neutral" variant="outline" @click="run(() => providerLogin('telegram'))" />
            <UFormField v-if="mode === 'setup' || recovering" :label="recovering ? 'Recovery key' : 'Private setup claim'"><UInput v-model="form.token" type="password" autocomplete="off" class="w-full" /></UFormField>
            <UFormField v-if="mode !== 'login'" label="Display name"><UInput v-model="form.name" autocomplete="name" class="w-full" /></UFormField>
            <UFormField label="Email"><UInput v-model="form.email" type="email" autocomplete="email" class="w-full" /></UFormField>
            <UFormField label="Password" :description="mode === 'login' ? undefined : 'Use at least 10 characters.'"><UInput v-model="form.password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" class="w-full" /></UFormField>
            <div class="flex items-center gap-3"><UButton type="submit" :label="recovering ? 'Recover account' : mode === 'setup' ? 'Create installation' : mode === 'signup' ? 'Create account' : 'Sign in'" :loading="busy" /><UButton v-if="(discovery.registration || invite) && mode !== 'setup'" color="neutral" variant="link" :label="mode === 'login' ? 'Create account' : 'Sign in instead'" @click="mode = mode === 'login' ? 'signup' : 'login'" /></div>
            <UButton v-if="mode === 'login'" :label="recovering ? 'Back to sign in' : 'Use a recovery key'" color="neutral" variant="link" @click="recovering = !recovering" />
          </form>
          <template v-else>
            <div v-if="discovery.origin === ownOrigin && (discovery.identity || discovery.telegramOidc)" class="mt-5 flex flex-wrap gap-2"><UButton v-if="discovery.identity" label="Link L4 account" color="neutral" variant="outline" @click="run(() => providerLogin('llll', true))" /><UButton v-if="discovery.telegramOidc" label="Link Telegram" color="neutral" variant="outline" @click="run(() => providerLogin('telegram', true))" /></div>
            <div class="mt-5"><UButton label="Replace recovery key" color="neutral" variant="outline" size="sm" @click="run(async () => { recoveryCode = (await connections.request<{ code: string }>(discovery!.origin, '/api/installation/recovery-key', { method: 'POST', body: {} })).code })" /><UAlert v-if="recoveryCode" class="mt-3" color="warning" title="Save this private key now. It replaces your previous key and can only be used once." :description="recoveryCode" /></div>
            <div class="mt-6 flex items-center justify-between"><h3 class="text-sm font-medium text-muted">Your servers</h3><UButton label="Sign out here" color="neutral" variant="link" size="xs" @click="run(signOut)" /></div>
            <div class="mt-3 grid gap-3 sm:grid-cols-2">
              <article v-for="server in selected.servers" :key="server.id" class="rounded-xl border border-default bg-elevated/40 p-4"><div class="flex items-center justify-between"><h4 class="font-medium">{{ server.name }}</h4><UBadge v-if="server.status !== 'ready'" color="warning" variant="subtle">{{ server.status }}</UBadge></div><div class="mt-4 flex gap-2"><UButton label="Open server" :disabled="server.status !== 'ready'" size="sm" @click="open(discovery!.origin, server.id)" /><UButton v-if="owner && server.status === 'failed'" label="Retry" size="sm" color="neutral" variant="outline" @click="run(async () => { await connections.request(discovery!.origin, `/api/installation/servers/${server.id}/retry`, { method: 'POST', body: {} }); await connections.refresh(discovery!.origin) })" /><UButton v-if="server.ownerId === selected.userId && server.status === 'ready'" label="Invite" size="sm" color="neutral" variant="outline" @click="run(() => makeInvite(server.id))" /></div></article>
            </div>
            <p v-if="!selected.servers.length" class="mt-4 text-sm text-muted">Join a server using an invitation, or ask the installation owner to add you.</p>
            <form v-if="owner" class="mt-6 flex items-end gap-2" @submit.prevent="run(createServer)"><UFormField label="Create a server" class="min-w-0 flex-1"><UInput v-model="serverName" placeholder="My community" class="w-full" /></UFormField><UButton type="submit" label="Create" :loading="busy" :disabled="!serverId" /></form>
            <form class="mt-6 flex items-end gap-2" @submit.prevent="run(join)"><UFormField label="Invitation code" class="min-w-0 flex-1"><UInput v-model="invite" placeholder="Paste an invitation code" class="w-full" /></UFormField><UButton type="submit" label="Join" color="neutral" variant="outline" :loading="busy" :disabled="!invite" /></form>
          </template>
        </template>
        <UButton v-else class="mt-6" label="Open server" @click="open(discovery.origin, discovery.id)" />
      </section>

      <section v-if="owner" class="rounded-2xl border border-default p-5">
        <div class="flex items-center justify-between gap-3"><h2 class="font-semibold">Installation settings</h2><UButton label="Back up installation" color="neutral" variant="outline" size="sm" :loading="busy" @click="run(async () => { await connections.request(discovery!.origin, '/api/installation/backup', { method: 'POST', body: {} }); toast.add({ title: 'Installation backup saved' }) })" /></div>
        <p class="mt-2 text-sm text-muted">Manage accounts and server provisioning for this installation. Saved secrets stay encrypted here.</p>
        <form class="mt-5 grid gap-4 sm:grid-cols-2" @submit.prevent="run(saveSettings)">
          <UFormField label="Telegram bot token" :description="configured?.telegram ? 'Configured' : 'Optional · enable Mini App login'"><UInput v-model="settings.telegramBotToken" type="password" autocomplete="off" class="w-full" /></UFormField>
          <UFormField label="Telegram client ID"><UInput v-model="settings.telegramClientId" autocomplete="off" class="w-full" /></UFormField>
          <UFormField label="Telegram client secret"><UInput v-model="settings.telegramClientSecret" type="password" autocomplete="off" class="w-full" /></UFormField>
          <UFormField label="Cloudflare account ID" :description="configured?.cloudflare ? 'Provisioning configured' : 'Enable automatic server creation'"><UInput v-model="settings.cloudflareAccountId" autocomplete="off" class="w-full" /></UFormField>
          <UFormField label="Cloudflare API token" description="Allows this installation to create and update servers. Saved tokens are never shown again."><UInput v-model="settings.cloudflareApiToken" type="password" autocomplete="off" class="w-full" /></UFormField>
          <div class="flex items-end"><UButton type="submit" label="Save settings" :loading="busy" /></div>
        </form>
        <details class="mt-6 border-t border-default pt-5"><summary class="cursor-pointer text-sm font-medium">Register a deployed server</summary>
          <form class="mt-4 grid gap-4 sm:grid-cols-2" @submit.prevent="run(registerServer)">
            <UFormField label="Server ID"><UInput v-model="registration.id" placeholder="main" class="w-full" /></UFormField>
            <UFormField label="Server name"><UInput v-model="registration.name" placeholder="My community" class="w-full" /></UFormField>
            <UFormField label="Server origin"><UInput v-model="registration.origin" placeholder="https://server.example.com" class="w-full" /></UFormField>
            <UFormField label="Pairing key"><UInput v-model="registration.key" type="password" autocomplete="off" class="w-full" /></UFormField>
            <UButton type="submit" label="Register server" :loading="busy" />
          </form>
        </details>
      </section>
      <section v-if="connections.installations.value.length" class="space-y-3"><h2 class="text-sm font-medium text-muted">Connected installations</h2><div v-for="installation in connections.installations.value" :key="installation.origin" class="flex items-center gap-3 rounded-xl border border-default p-4"><button class="min-w-0 flex-1 text-start" @click="run(() => inspect(installation.origin))"><span class="block font-medium">{{ installation.name }}</span><span class="block truncate text-xs text-muted">{{ installation.origin }}</span></button><UButton icon="i-ph-trash" color="neutral" variant="ghost" :aria-label="`Forget ${installation.name}`" @click="connections.remove(installation.origin)" /></div></section>
      <p class="text-xs text-muted">L4 is free, MIT licensed software. Your installation runs on your Cloudflare account or VPS.</p>
    </div>
  </main>
</template>

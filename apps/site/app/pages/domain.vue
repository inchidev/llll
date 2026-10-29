<script setup lang="ts">
useHead({ title: 'Server address · L4' })

type DomainRequest = {
  origin: string
  accountId: string
  workerName: string
  requestId: string
  action: 'add' | 'remove' | 'primary'
  hostname: string
  makePrimary?: boolean
  serverId?: string
}
type DomainResult = {
  action: 'add' | 'remove' | 'primary'
  hostname: string
  origin: string
  primary: boolean
  origins: Array<{ origin: string, hostname: string, primary: boolean }>
}
type Session = {
  authorized: boolean
  error?: string
  domainRequest?: Omit<DomainRequest, 'token'>
}

const route = useRoute()
const router = useRouter()
const session = ref<Session | null>(null)
const loading = ref(true)
const starting = ref(false)
const error = ref('')
const result = ref<DomainResult | null>(null)

const queryRequest = computed<DomainRequest | null>(() => {
  const origin = String(route.query.server || '')
  const accountId = String(route.query.account || '')
  const workerName = String(route.query.worker || '')
  const requestId = String(route.query.domainRequest || '')
  const token = String(route.query.domainToken || '')
  const action = String(route.query.action || '') as DomainRequest['action']
  const hostname = String(route.query.hostname || '')
  if (!origin || !accountId || !workerName || !requestId || !token || !['add', 'remove', 'primary'].includes(action) || !hostname) return null
  return {
    origin, accountId, workerName, requestId, action, hostname, token,
    makePrimary: route.query.primary === '1',
    serverId: String(route.query.serverId || '') || undefined,
  }
})
const request = computed<DomainRequest | null>(() => session.value?.domainRequest || queryRequest.value)
const serverId = computed(() => request.value?.serverId || String(route.query.serverId || ''))
const returnOrigin = computed(() => {
  const origins = result.value?.origins
  const startingOrigin = request.value?.origin
  if (startingOrigin && origins?.some(item => item.origin === startingOrigin)) return startingOrigin
  return origins?.find(item => item.primary)?.origin || startingOrigin || ''
})
const returnUrl = computed(() => {
  const origin = returnOrigin.value
  if (!origin) return '/'
  return serverId.value
    ? `${origin}/server/${encodeURIComponent(serverId.value)}/settings?section=domains`
    : `${origin}/settings?section=domains`
})
const actionLabel = computed(() => request.value?.action === 'remove' ? 'Remove address' : request.value?.action === 'primary' ? 'Make primary' : 'Add address')

function message(cause: unknown) {
  const value = cause as { data?: { error?: { message?: string }, message?: string }, message?: string }
  return value.data?.error?.message || value.data?.message || value.message || 'The domain change did not complete.'
}

async function prepare() {
  if (!queryRequest.value) return
  await $fetch('/api/deploy/domain/prepare', { method: 'POST', body: queryRequest.value })
  const next: Record<string, string> = { resume: '1' }
  if (queryRequest.value.serverId) next.serverId = queryRequest.value.serverId
  await router.replace({ path: '/domain', query: next })
}

async function refresh() {
  session.value = await $fetch<Session>('/api/deploy/session')
}

async function start() {
  if (starting.value || result.value) return
  starting.value = true
  error.value = ''
  try {
    const response = await $fetch<{ domain: DomainResult }>('/api/deploy/domain/start', { method: 'POST' })
    result.value = response.domain
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    starting.value = false
  }
}

function authorize() {
  window.location.href = '/api/deploy/oauth?next=domain'
}

onMounted(async () => {
  try {
    if (queryRequest.value) await prepare()
    await refresh()
    if (session.value?.authorized && session.value.domainRequest) await start()
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    loading.value = false
  }
})
</script>

<template>
  <section class="mx-auto w-full max-w-xl px-4 py-10 sm:px-8">
    <p class="text-sm font-medium uppercase tracking-wide text-muted">L4 · Official installer</p>
    <h1 class="mt-2 text-2xl font-semibold tracking-tight text-highlighted">{{ result ? 'Address connected' : 'Server address' }}</h1>
    <p class="mt-3 text-sm leading-6 text-muted">
      Cloudflare authorization is used once in this browser. The Server receives no account-wide credential.
    </p>

    <UAlert v-if="error || session?.error" class="mt-6" color="error" title="The change did not complete" :description="error || session?.error" />

    <div v-if="loading" class="mt-8 space-y-3" role="status" aria-label="Loading">
      <div class="h-4 w-2/3 animate-pulse rounded bg-elevated" />
      <div class="h-4 w-1/2 animate-pulse rounded bg-elevated" />
    </div>

    <template v-else-if="request">
      <dl class="mt-8 grid gap-3 rounded-xl border border-default p-4 text-sm">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <dt class="text-muted">Action</dt>
          <dd class="font-medium text-highlighted">{{ actionLabel }}</dd>
        </div>
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <dt class="text-muted">Hostname</dt>
          <dd class="break-all font-medium text-highlighted">{{ request.hostname }}</dd>
        </div>
        <div v-if="request.makePrimary" class="flex flex-wrap items-baseline justify-between gap-2">
          <dt class="text-muted">Primary</dt>
          <dd class="font-medium text-highlighted">Make this the primary address</dd>
        </div>
      </dl>

      <template v-if="result">
        <UAlert class="mt-6" color="success" title="Every listed address keeps working" description="Login, links and MCP accept the primary and each alias. workers.dev remains enabled." />
        <ul class="mt-4 divide-y divide-default rounded-xl border border-default text-sm">
          <li v-for="item in result.origins" :key="item.origin" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span class="min-w-0 break-all">{{ item.hostname }}</span>
            <UBadge v-if="item.primary" color="primary" variant="subtle">Primary</UBadge>
          </li>
        </ul>
        <div class="mt-6 flex flex-wrap gap-3">
          <UButton :to="returnUrl" label="Return to Server settings" />
          <UButton to="/" color="neutral" variant="ghost" label="Done" />
        </div>
      </template>

      <template v-else-if="!session?.authorized">
        <p class="mt-6 text-sm leading-6 text-muted">
          Connect the Cloudflare account that owns this Server. This one-time grant is never stored on the Server.
        </p>
        <UButton class="mt-4" icon="i-ph-cloud" label="Connect Cloudflare" size="lg" @click="authorize" />
      </template>

      <template v-else>
        <p class="mt-6 text-sm leading-6 text-muted">
          Attach the address in Cloudflare and update this Server. Keep this window open while it finishes.
        </p>
        <div class="mt-4 flex flex-wrap gap-3">
          <UButton icon="i-ph-cloud-check" :label="starting ? 'Applying the change…' : 'Apply the change'" :loading="starting" size="lg" @click="start" />
          <UButton color="neutral" variant="ghost" label="Use a different Cloudflare account" @click="authorize" />
        </div>
      </template>
    </template>

    <template v-else>
      <UAlert class="mt-8" color="neutral" title="Open this page from Server settings" description="In your Server, open Server settings → Deployment → Domain and choose Add address. Each link is single-use." />
      <UButton class="mt-4" to="/create" color="neutral" variant="outline" label="Add a Server instead" />
    </template>
  </section>
</template>

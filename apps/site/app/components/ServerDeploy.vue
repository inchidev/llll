<script setup lang="ts">
import {
  readDeployedInstallations,
  recordDeployedInstallation,
  type DeployedInstallation,
} from '../../../../shared/deploy-recall'

const route = useRoute()
const method = ref(route.query.method === 'vps' ? 'vps' : 'cloudflare')
const phases = [
  'Configure your Server',
  'Start deployment',
  'Wait for Cloudflare verification',
  'Ready',
]
const name = ref('My L4')
const ownerEmail = ref('')
const accountId = ref('')
const busy = ref(false)
const error = ref('')
const config = ref<{ oauth: boolean } | null>(null)
const session = ref<{
  authorized: boolean
  accounts: { id: string; name: string }[]
  step?: number
  name?: string
  ownerEmail?: string
  version?: string
  grantExpiresIn?: number
  error?: string
  completed?: boolean
  claim?: string
  origin?: string
} | null>(null)
const versions = ref<
  { version: string; name: string; published_at: string; notes_url: string }[]
>([])
const version = ref('')
const releasesError = ref('')
const remembered = ref<DeployedInstallation[]>([])
/** Set when the web session is gone and this browser deployed before: the page then says so instead of silently looking new. */
const sessionEnded = ref(false)
/** Deployments in flight navigate straight to the shell; returning later shows the completion screen again without redirecting. */
const redirected = ref(false)
const openRoute = computed(() => {
  const claim = session.value?.claim?.split('#claim=')[1]
  return `/open?server=${encodeURIComponent(session.value?.origin || '')}${claim ? `&claim=${claim}` : ''}`
})
const now = ref(Date.now())
const grantExpiresAt = ref(0)
const grantLeft = computed(() => {
  if (
    !session.value?.authorized ||
    session.value.completed ||
    !grantExpiresAt.value
  )
    return ''
  const seconds = Math.max(
    0,
    Math.round((grantExpiresAt.value - now.value) / 1000),
  )
  return `Cloudflare authorization: ~${Math.floor(seconds / 60)} min left, renews automatically while deploying.`
})
/** Hide the remembered list while a deployment is running or a fresh one just finished. */
const rememberVisible = computed(
  () => !session.value?.completed && session.value?.step === undefined,
)

async function refresh() {
  try {
    session.value = await $fetch('/api/deploy/session')
    accountId.value ||= session.value?.accounts[0]?.id || ''
    ownerEmail.value ||= session.value?.ownerEmail || ''
    error.value = session.value?.error || ''
    sessionEnded.value = false
    if (session.value?.completed && session.value.origin)
      remembered.value = recordDeployedInstallation({
        origin: session.value.origin,
        name: session.value.name || '',
        completedAt: Date.now(),
      })
  } catch (cause) {
    const status = (cause as { status?: number }).status
    // 401: no session (anonymous first visit) — the connect CTA is enough. 503: the deployment
    // service is not configured here (previews, minimal self-host): keep the screen quiet.
    if (status === 401) sessionEnded.value = remembered.value.length > 0
    else if (status !== 503) error.value = 'Could not load deployment state'
  }
  if (session.value?.grantExpiresIn !== undefined)
    grantExpiresAt.value = Date.now() + session.value.grantExpiresIn * 1000
}
async function deploy() {
  busy.value = true
  error.value = ''
  try {
    if (session.value?.step === undefined)
      await $fetch('/api/deploy/start', {
        method: 'POST',
        body: {
          accountId: accountId.value,
          name: name.value,
          ownerEmail: ownerEmail.value,
          version: version.value,
        },
      })
    await refresh()
    while (!session.value?.completed) {
      await $fetch('/api/deploy/advance', { method: 'POST', timeout: 150000 })
      await refresh()
      if (!session.value?.completed)
        await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    if (session.value?.origin && !redirected.value) {
      redirected.value = true
      await navigateTo(openRoute.value)
    }
  } catch (cause) {
    error.value =
      (cause as { data?: { error?: { message?: string } } }).data?.error
        ?.message || 'Deployment paused. Retry to resume the same server.'
  } finally {
    busy.value = false
  }
}
onMounted(async () => {
  remembered.value = readDeployedInstallations()
  config.value = await $fetch('/api/deploy/config')
  await refresh()
  setInterval(() => {
    now.value = Date.now()
  }, 1000)
  try {
    const data = await $fetch<{
      releases: {
        version: string
        name: string
        published_at: string
        notes_url: string
      }[]
    }>('/api/deploy/releases')
    versions.value = data.releases
    version.value = session.value?.version || data.releases[0]?.version || ''
  } catch {
    releasesError.value =
      'Could not load the release list. Enter a version like v0.1.0-alpha.1.'
  }
})

const copied = ref(false)
async function copyOrigin() {
  if (!session.value?.origin) return
  try {
    await navigator.clipboard.writeText(session.value.origin)
  } catch {
    /* Clipboard access can be denied; the address stays selectable on the page. */ return
  }
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 2000)
}
</script>
<template>
  <UContainer class="max-w-3xl py-8 sm:py-16">
    <h1 class="text-4xl font-semibold tracking-tight">Install your own L4</h1>
    <p class="mt-4 text-muted">
      Your accounts, servers and data. Free MIT software.
    </p>

    <UAlert
      v-if="sessionEnded"
      class="mt-8"
      color="warning"
      title="Your deploy session ended"
      description="Cloudflare authorization lasts about an hour. Reconnect Cloudflare below — your existing servers are remembered on this device."
    />

    <section v-if="rememberVisible && remembered.length" class="mt-8 space-y-3">
      <h2 class="text-xl font-semibold tracking-tight">Your servers</h2>
      <p class="text-sm text-muted">
        Completed from this browser. Open one in the shell, or deploy a new
        server below.
      </p>
      <ul class="space-y-2">
        <li
          v-for="entry in remembered"
          :key="entry.origin"
          class="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-default px-3 py-2"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-highlighted">
              {{ entry.name || 'L4 server' }}
            </p>
            <p class="truncate text-xs text-muted">
              {{ entry.origin.replace(/^https:\/\//, '') }}
            </p>
          </div>
          <UButton
            :to="`/open?server=${encodeURIComponent(entry.origin)}`"
            label="Open in the shell"
            icon="i-ph-arrow-square-out"
            color="neutral"
            variant="outline"
            size="xs"
          />
        </li>
      </ul>
    </section>

    <UTabs
      v-if="
        !session?.authorized &&
        session?.step === undefined &&
        !session?.completed
      "
      v-model="method"
      class="mt-8"
      :items="[
        { label: 'Cloudflare', value: 'cloudflare' },
        { label: 'VPS / Coolify', value: 'vps' },
      ]"
    />
    <section
      v-if="method === 'cloudflare' || session?.authorized"
      class="mt-8 space-y-6"
    >
      <p v-if="grantLeft" class="text-sm text-muted">{{ grantLeft }}</p>
      <template v-if="session?.completed">
        <h2 class="text-2xl font-semibold">Your server is ready</h2>
        <p class="text-muted">
          Create its owner, save the recovery key, then create your first
          server.
        </p>
        <UButton
          :to="session.claim"
          external
          label="Create server owner"
          size="lg"
        />
        <p class="break-all text-sm text-muted">{{ session.origin }}</p>
        <div class="flex flex-wrap gap-2">
          <UButton
            :to="openRoute"
            label="Open in the shell"
            icon="i-ph-arrow-square-out"
            color="neutral"
            variant="outline"
          />
          <UButton
            :label="copied ? 'Copied' : 'Copy server URL'"
            :disabled="!session.origin"
            color="neutral"
            variant="outline"
            @click="copyOrigin"
          />
        </div>
        <p class="text-sm text-muted">
          The address above is the only identifier of your server — copy it
          somewhere safe. This browser will remember it in Connections; other
          devices need it again.
        </p>
      </template>
      <template
        v-else-if="
          session && (session.authorized || session.step !== undefined)
        "
      >
        <template v-if="session.step === undefined">
          <UFormField label="Cloudflare account"
            ><USelect
              v-model="accountId"
              :items="
                session.accounts.map((a) => ({ label: a.name, value: a.id }))
              "
              class="w-full"
          /></UFormField>
          <UFormField label="Owner email"
            ><UInput v-model="ownerEmail" type="email" required class="w-full"
          /></UFormField>
          <UFormField label="Server name"
            ><UInput v-model="name" class="w-full" maxlength="80"
          /></UFormField>
          <UFormField label="Release version">
            <USelect
              v-if="versions.length"
              v-model="version"
              :items="
                versions.map((r) => ({
                  label: r.published_at
                    ? `${r.version} — ${r.published_at.slice(0, 10)}`
                    : r.version,
                  value: r.version,
                }))
              "
              class="w-full"
            />
            <UInput
              v-else
              v-model="version"
              placeholder="v0.1.0-alpha.1"
              class="w-full"
            />
            <template #hint
              ><a
                href="https://github.com/inchidev/llll/releases"
                target="_blank"
                rel="noopener"
                class="underline"
                >Published GitHub releases</a
              >, newest first</template
            >
          </UFormField>
          <p
            v-if="releasesError && !versions.length"
            class="text-sm text-muted"
          >
            {{ releasesError }}
          </p>
        </template>
        <ol v-else class="space-y-4">
          <li
            v-for="(phase, index) in phases"
            :key="phase"
            class="flex items-center gap-3"
            :class="
              index > (session.step || 0) ? 'text-dimmed' : 'text-highlighted'
            "
          >
            <UIcon
              :name="
                index < (session.step || 0)
                  ? 'i-ph-check-circle'
                  : 'i-ph-circle'
              "
              class="size-5"
            />{{ phase }}
          </li>
        </ol>
        <p
          v-if="session.step !== undefined && session.version"
          class="text-sm text-muted"
        >
          Release {{ session.version }}
        </p>
        <UButton
          :label="
            session.step === undefined ? 'Deploy server' : 'Resume deployment'
          "
          :loading="busy"
          :disabled="session.step === undefined && !version"
          size="lg"
          @click="deploy"
        />
      </template>
      <template v-else>
        <p class="text-muted">
          Authorize L4 to deploy into your Cloudflare account. Its credentials
          are handed to your server after deployment.
        </p>
        <UButton
          to="/api/deploy/oauth"
          external
          :label="sessionEnded ? 'Reconnect Cloudflare' : 'Connect Cloudflare'"
          icon="i-ph-cloud"
          size="lg"
          :disabled="!config?.oauth"
        />
        <p v-if="config && !config.oauth" class="text-sm text-muted">
          The deployment service is awaiting its OAuth configuration.
          <a
            href="https://github.com/inchidev/llll/blob/main/docs/deployment.md"
            class="underline"
            >Manual setup</a
          >
          remains available.
        </p>
        <p class="text-sm text-muted">
          Cloudflare bills infrastructure usage directly. Enable R2 before
          deploying.
        </p>
      </template>
      <UAlert v-if="error" color="error" :description="error" /><UButton
        v-if="error && session?.step !== undefined"
        to="/api/deploy/oauth?resume=1"
        external
        label="Reconnect Cloudflare"
        color="neutral"
        variant="outline"
      />
    </section>
    <section v-else class="mt-8 space-y-6">
      <h2 class="text-2xl font-semibold">celld + Docker Compose</h2>
      <p class="text-muted">
        Generate a private server with isolated server services. Run it on your
        VPS or import the Compose project into Coolify, then configure HTTPS.
      </p>
      <pre
        class="overflow-x-auto rounded-lg border border-default p-4 text-xs leading-6"
      >
git clone https://github.com/inchidev/llll.git
cd llll
node scripts/self-host-server.mjs .deployment/my-l4 https://chat.example.com main games
docker compose -f .deployment/my-l4/compose.json up -d --build</pre>
      <p class="text-sm text-muted">
        Keep generated credentials private. Open the owner claim link, then
        register the generated servers. Automatic SSH deployment is not
        available yet.
      </p>
      <UButton
        to="https://github.com/inchidev/llll/blob/main/docs/deployment.md"
        label="VPS deployment guide"
        color="neutral"
        variant="outline"
        external
      />
    </section>
  </UContainer>
</template>

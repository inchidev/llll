<script setup lang="ts">
import { z } from 'zod'
import { deploymentShellUrl } from '../../../../shared/deploy-handoff'
import {
  readDeployedServers,
  recordDeployedServer,
  type DeployedServer,
} from '../../../../shared/deploy-recall'

const phases = [
  'Configure your Server',
  'Start deployment',
  'Wait for Cloudflare verification',
  'Ready',
]
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
const remembered = ref<DeployedServer[]>([])
/** Set when the web session is gone and this browser deployed before: the page then says so instead of silently looking new. */
const sessionEnded = ref(false)
/** Deployments in flight navigate straight to the shell; returning later shows the completion screen again without redirecting. */
const redirected = ref(false)
const openRoute = computed(() => deploymentShellUrl(session.value?.origin || '', session.value?.claim))
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
      remembered.value = recordDeployedServer({
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
let clock: ReturnType<typeof setInterval> | undefined
onUnmounted(() => clearInterval(clock))
onMounted(async () => {
  remembered.value = readDeployedServers()
  config.value = await $fetch('/api/deploy/config')
  await refresh()
  clock = setInterval(() => {
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
      'Could not load the release list. Enter a published version, for example v0.2.0-alpha.1.'
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
  <section class="space-y-6">
    <p class="text-sm leading-6 text-muted">Deploy to your Cloudflare account. Start on workers.dev, with your own accounts and data.</p>

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
            :to="`/create?server=${encodeURIComponent(entry.origin)}`"
            label="Open in the shell"
            icon="i-ph-arrow-square-out"
            color="neutral"
            variant="outline"
            size="xs"
          />
        </li>
      </ul>
    </section>

    <section class="space-y-6">
      <p v-if="grantLeft" class="text-sm text-muted">{{ grantLeft }}</p>
      <template v-if="session?.completed">
        <h2 class="text-2xl font-semibold">Your Server is deployed</h2>
        <p class="text-muted">
          Continue with {{ session.ownerEmail }}. Choose your password on the Server to finish signing in as its owner.
        </p>
        <UButton
          :to="openRoute"
          label="Continue as owner"
          size="lg"
        />
        <p class="break-all text-sm text-muted">{{ session.origin }}</p>
        <div class="flex flex-wrap gap-2">
          <UButton
            :to="session.claim"
            external
            label="Open Server directly"
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
          Save the address above to connect to your Server. This browser will remember it in Connections; other
          devices need it again.
        </p>
      </template>
      <UForm
        v-else-if="
          session && (session.authorized || session.step !== undefined)
        "
        :schema="session.step === undefined ? formSchema : undefined"
        :state="{ accountId, name, ownerEmail, version }"
        class="space-y-6"
        @submit="deploy"
      >
        <template v-if="session.step === undefined">
          <UFormField name="accountId" label="Cloudflare account"
            ><USelect
              v-model="accountId"
              :items="
                session.accounts.map((a) => ({ label: a.name, value: a.id }))
              "
              class="w-full"
          /></UFormField>
          <UFormField name="ownerEmail" label="Your admin email" description="Your local owner account on this Server. You’ll choose its password after deployment."
            ><UInput v-model="ownerEmail" name="email" autocomplete="email" type="email" required class="w-full"
          /></UFormField>
          <UFormField name="name" label="Server name"
            ><UInput v-model="name" class="w-full" maxlength="80"
          /></UFormField>
          <UFormField name="version" label="Release version">
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
              placeholder="v0.2.0-alpha.1"
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
          type="submit"
          :label="
            session.step === undefined ? 'Deploy server' : 'Resume deployment'
          "
          :loading="busy"
          :disabled="session.step === undefined && !version"
          size="lg"
        />
      </UForm>
      <template v-else>
        <p class="text-muted">
          Authorize L4 to configure deployment in your Cloudflare account.
          Your Server owns its accounts and login.
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
          Before connecting, enable R2 and configure the repository connection
          and deployment token in Workers Builds. Cloudflare bills usage
          directly.
        </p>
      </template>
      <UAlert v-if="error" color="error" :description="error" /><UButton
        v-if="error && (session?.authorized || session?.step !== undefined)"
        to="/api/deploy/oauth?resume=1"
        external
        label="Reconnect Cloudflare"
        color="neutral"
        variant="outline"
      />
    </section>
  </section>
</template>

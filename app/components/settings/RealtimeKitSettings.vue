<script setup lang="ts">
import type { RealtimeKitSettingsAdminDTO } from '~~/shared/types'
const { api } = useApi()

type Account = { id: string, name: string }

const props = defineProps<{ serverId: string }>()
const toast = useToast()
const session = useSessionStore()
const loading = ref(true)
const connecting = ref(false)
const testing = ref(false)
const removing = ref(false)
const removeConfirm = ref(false)
const replacing = ref(false)
const apiToken = ref('')
const accounts = ref<Account[]>([])
const accountId = ref('')
const realtimekit = ref<RealtimeKitSettingsAdminDTO | null>(null)

// Account API tokens belong to the account, not to whoever created them.
const createTokenUrl = 'https://dash.cloudflare.com/?to=/:account/api-tokens&name=L4%20Live'

const managed = computed(() => realtimekit.value?.source === 'deployment')
const connected = computed(() => Boolean(realtimekit.value?.configured))
const unreadable = computed(() => realtimekit.value?.source === 'database' && !realtimekit.value.secretReadable)
const callsUnavailable = computed(() => session.health?.capabilities?.calls === false)
const restCalls = computed(() => session.health?.capabilities?.callsProvider === 'realtimekit-rest')
const showTokenForm = computed(() => !callsUnavailable.value && !managed.value && (!connected.value || replacing.value || unreadable.value))
const statusLabel = computed(() => {
  if (connected.value) return 'Connected'
  if (unreadable.value) return 'Reconnect needed'
  if (restCalls.value) return 'API token'
  return 'Not connected'
})

function apply(value: RealtimeKitSettingsAdminDTO) {
  realtimekit.value = value
  // The app shell reads this to decide whether to offer calls at all.
  if (session.health) {
    session.health = {
      ...session.health,
      realtimekit: value.configured || session.health.capabilities?.callsProvider === 'realtimekit-rest',
    }
  }
}

async function load() {
  loading.value = true
  try {
    const response = await api<{ realtimekit: RealtimeKitSettingsAdminDTO }>(`/api/servers/${props.serverId}/realtimekit`)
    apply(response.realtimekit)
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    loading.value = false
  }
}

/** With a token: connect or replace it. Without one: reconnect using the saved token. */
async function connect(withToken: boolean) {
  connecting.value = true
  try {
    const response = await api<{ realtimekit: RealtimeKitSettingsAdminDTO } | { accounts: Account[] }>(
      `/api/servers/${props.serverId}/realtimekit/connect`,
      {
        method: 'POST',
        body: {
          ...(withToken ? { apiToken: apiToken.value.trim() } : {}),
          ...(accountId.value ? { accountId: accountId.value } : {}),
        },
      },
    )
    if ('accounts' in response) {
      accounts.value = response.accounts
      accountId.value = response.accounts[0]?.id ?? ''
      return
    }
    apply(response.realtimekit)
    apiToken.value = ''
    accounts.value = []
    accountId.value = ''
    replacing.value = false
    toast.add({ title: 'Live is connected', description: 'Every channel and direct message can now go live.', color: 'success' })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    connecting.value = false
  }
}

async function testConnection() {
  testing.value = true
  try {
    await api(`/api/servers/${props.serverId}/realtimekit/test`, { method: 'POST' })
    toast.add({ title: 'RealtimeKit is working', color: 'success' })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    testing.value = false
  }
}

async function remove() {
  removing.value = true
  try {
    const response = await api<{ realtimekit: RealtimeKitSettingsAdminDTO }>(`/api/servers/${props.serverId}/realtimekit`, {
      method: 'DELETE',
    })
    apply(response.realtimekit)
    removeConfirm.value = false
    toast.add({ title: 'Live disconnected', color: 'success' })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    removing.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="flex items-center gap-3">
      <h1 class="text-xl font-semibold text-highlighted">Live</h1>
      <UBadge :label="statusLabel" :color="connected ? 'success' : 'neutral'" variant="subtle" />
    </div>
    <p class="mt-1 text-sm text-muted">
      Every channel and direct message has one live room for audio, camera, and screen sharing. A 1:1 direct message rings as a call. Media runs on Cloudflare RealtimeKit in your account; nothing is recorded.
    </p>
    <UAlert
      v-if="callsUnavailable"
      class="mt-6"
      color="neutral"
      variant="subtle"
      title="Calls are unavailable on this runtime"
      description="Live sessions and calls use Cloudflare RealtimeKit. This Server is not on Cloudflare's network, so they stay off. Text chat is unaffected."
    />
    <UAlert
      v-else-if="restCalls && !connected"
      class="mt-6"
      color="neutral"
      variant="subtle"
      title="Calls use your Cloudflare API token"
      description="The first call creates a RealtimeKit app with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. A separate Realtime token is optional."
    />

    <LayoutSkeleton v-if="loading" variant="form" class="mt-6" />
    <template v-else-if="realtimekit">
      <UAlert
        v-if="managed"
        class="mt-6"
        color="neutral"
        variant="subtle"
        title="Managed by the deployment"
        description="RealtimeKit credentials come from the Worker's environment and override anything saved here."
      />
      <UAlert
        v-else-if="unreadable"
        class="mt-6"
        color="error"
        variant="subtle"
        title="The saved token can no longer be read"
        description="AUTH_SECRET changed since Live was connected. Paste a token to reconnect."
      />
      <UAlert
        v-else-if="connected && realtimekit.sharedPreset"
        class="mt-6"
        color="warning"
        variant="subtle"
        title="Everyone joins with host controls"
        description="Live was connected before hosts and participants had separate permissions. Reconnect to set them up."
        :actions="[{ label: 'Reconnect', color: 'warning', variant: 'solid', loading: connecting, onClick: () => connect(false) }]"
      />

      <dl v-if="connected" class="mt-6 grid gap-x-6 gap-y-3 rounded-lg border border-default p-4 text-sm sm:grid-cols-2">
        <div>
          <dt class="text-xs text-muted">Account</dt>
          <dd class="truncate font-mono text-xs text-highlighted">{{ realtimekit.accountId }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">RealtimeKit app</dt>
          <dd class="truncate font-mono text-xs text-highlighted">{{ realtimekit.appId }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Host preset</dt>
          <dd class="truncate font-mono text-xs text-highlighted">{{ realtimekit.hostPreset }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Participant preset</dt>
          <dd class="truncate font-mono text-xs text-highlighted">{{ realtimekit.participantPreset }}</dd>
        </div>
      </dl>

      <div v-if="showTokenForm" class="mt-6 space-y-4">
        <ol class="space-y-3 text-sm">
          <li class="flex gap-3">
            <span class="grid size-6 shrink-0 place-items-center rounded-full bg-elevated text-xs font-semibold">1</span>
            <div class="min-w-0 flex-1">
              <p class="text-highlighted">Create a Cloudflare API token</p>
              <p class="text-muted">Give it the permission <span class="font-medium text-default">Realtime Admin</span> for the account L4 runs in.</p>
              <UButton
                class="mt-2"
                size="sm"
                color="neutral"
                variant="soft"
                icon="i-ph-arrow-square-out"
                label="Create token"
                :to="createTokenUrl"
                target="_blank"
              />
            </div>
          </li>
          <li class="flex gap-3">
            <span class="grid size-6 shrink-0 place-items-center rounded-full bg-elevated text-xs font-semibold">2</span>
            <div class="min-w-0 flex-1">
              <p class="text-highlighted">Paste it here</p>
              <p class="text-muted">L4 sets up its own RealtimeKit app and presets. The token is stored encrypted.</p>
              <UInput
                v-model="apiToken"
                class="mt-2 w-full"
                type="password"
                placeholder="Cloudflare API token"
                autocomplete="new-password"
                @keydown.enter.prevent="apiToken.trim() && connect(true)"
              />
            </div>
          </li>
        </ol>

        <UFormField v-if="accounts.length" label="This token reaches more than one account. Which one should Live use?">
          <USelect v-model="accountId" :items="accounts.map(item => ({ label: item.name, value: item.id }))" value-key="value" class="w-full" />
        </UFormField>

        <div class="flex justify-end gap-2">
          <UButton v-if="replacing" label="Cancel" color="neutral" variant="ghost" @click="replacing = false; apiToken = ''; accounts = []" />
          <UButton label="Connect" icon="i-ph-plugs-connected" :loading="connecting" :disabled="!apiToken.trim()" @click="connect(true)" />
        </div>
      </div>

      <div v-if="connected && !callsUnavailable" class="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div v-if="!managed" class="flex items-center gap-2">
          <template v-if="removeConfirm">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="removeConfirm = false" />
            <UButton label="Disconnect Live" color="error" variant="soft" :loading="removing" @click="remove" />
          </template>
          <UButton v-else label="Disconnect" color="error" variant="ghost" @click="removeConfirm = true" />
        </div>
        <span v-else />
        <div class="flex items-center gap-2">
          <UButton v-if="!managed && !replacing" label="Replace token" color="neutral" variant="ghost" @click="replacing = true" />
          <UButton label="Test connection" icon="i-ph-pulse" color="neutral" variant="soft" :loading="testing" @click="testConnection" />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { AdminSession } from '../composables/useAdmin'

const props = defineProps<{ session: AdminSession }>()
const emit = defineEmits<{ changed: [] }>()
const toast = useToast()
const pasteOpen = ref(false)
const token = ref('')
const busy = ref('')

const credential = computed(() => props.session.credential)
const status = computed(() => {
  if (credential.value?.problem) return { label: 'Reconnect needed', color: 'error' as const }
  if (credential.value?.connected || credential.value?.pendingHandover) return { label: 'Connected', color: 'success' as const }
  return { label: 'Not connected', color: 'neutral' as const }
})
// Account API tokens belong to the account, so they survive people leaving it.
const tokenPage = computed(() => `https://dash.cloudflare.com/${props.session.accountId}/api-tokens`)

async function reconnect() {
  busy.value = 'oauth'
  try {
    const { url } = await adminFetch<{ url: string }>('/api/cloudflare/reconnect', { method: 'POST' })
    window.location.href = url
  }
  catch (cause) {
    toast.add({ title: failureMessage(cause), color: 'error' })
    busy.value = ''
  }
}

async function saveToken() {
  busy.value = 'token'
  try {
    await adminFetch('/api/cloudflare/token', { method: 'POST', body: { token: token.value } })
    token.value = ''
    pasteOpen.value = false
    toast.add({ title: 'Cloudflare connected', color: 'success' })
    emit('changed')
  }
  catch (cause) {
    toast.add({ title: failureMessage(cause), color: 'error' })
  }
  finally {
    busy.value = ''
  }
}
</script>

<template>
  <section class="rounded-lg border border-default p-5">
    <div class="flex flex-wrap items-center gap-3">
      <UIcon name="i-ph-cloud" class="size-5 text-primary" />
      <h2 class="font-semibold text-highlighted">Cloudflare</h2>
      <UBadge :label="status.label" :color="status.color" variant="subtle" />
      <span class="font-mono text-xs text-dimmed">{{ session.accountId }}</span>
    </div>
    <p class="mt-2 text-sm text-muted">
      The Admin is the only place in this account that holds a Cloudflare credential. Workspaces reach it through a service binding and hold none.
    </p>
    <UAlert v-if="credential?.problem" class="mt-4" color="error" title="Cloudflare stopped accepting the credential" :description="credential.problem" />
    <p v-else-if="credential?.connected" class="mt-2 text-xs text-dimmed">
      {{ credential.kind === 'oauth' ? 'Connected with Cloudflare OAuth' : 'Connected with an account API token' }}
      <template v-if="credential.updatedAt"> · {{ new Date(credential.updatedAt).toLocaleString() }}</template>
    </p>
    <div class="mt-4 flex flex-wrap gap-2">
      <UButton :label="credential?.connected ? 'Reconnect with Cloudflare' : 'Connect with Cloudflare'" icon="i-ph-plugs-connected" :loading="busy === 'oauth'" @click="reconnect" />
      <UButton label="Use an API token" color="neutral" variant="outline" @click="pasteOpen = !pasteOpen" />
    </div>
    <div v-if="pasteOpen" class="mt-4 space-y-3 rounded-lg bg-elevated p-4">
      <p class="text-sm text-muted">
        Create an account API token with Workers, D1, R2, KV, Realtime, DNS, Email, and Access permissions for this account, then paste it here. It is stored encrypted and never leaves the Admin.
      </p>
      <UButton :to="tokenPage" target="_blank" label="Open account API tokens" icon="i-ph-arrow-square-out" color="neutral" variant="soft" size="sm" />
      <UInput v-model="token" type="password" placeholder="Cloudflare API token" autocomplete="off" class="w-full" />
      <div class="flex justify-end">
        <UButton label="Save token" :loading="busy === 'token'" :disabled="!token.trim()" @click="saveToken" />
      </div>
    </div>
  </section>
</template>

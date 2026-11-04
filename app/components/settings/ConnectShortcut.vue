<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { useClipboard } from '@vueuse/core'
import { recordingUploadLink, type CreatedRecordingKeyDTO, type RecordingKeyDTO } from '~~/shared/task-recordings'

const { api, serverUrl } = useApi()
const { serverId } = useServer()
const { activeSpace, canSwitch } = useSpaces(serverId)
const { copy } = useClipboard()
const toast = useToast()
const qc = useQueryClient()

const tabs = [{ label: 'Install', value: 'install' as const }, { label: 'Your links', value: 'keys' as const }]
const tab = ref<'install' | 'keys'>('install')
const keysQ = useQuery({ queryKey: ['recording-keys'], queryFn: () => api<{ keys: RecordingKeyDTO[] }>('/api/me/recording-keys') })
const created = ref<CreatedRecordingKeyDTO | null>(null)
const personalLink = computed(() => created.value ? serverUrl(recordingUploadLink(created.value.token)) : '')
const busy = ref(false)
const error = ref('')

async function copyValue(value: string, label: string) {
  await copy(value)
  toast.add({ title: `${label} copied`, color: 'success' })
}

function deviceName() {
  const agent = navigator.userAgent
  return /iPhone/u.test(agent) ? 'iPhone' : /iPad/u.test(agent) ? 'iPad' : 'This device'
}

async function makeKey() {
  busy.value = true
  error.value = ''
  try {
    created.value = (await api<{ key: CreatedRecordingKeyDTO }>('/api/me/recording-keys', { method: 'POST', body: { name: deviceName() } })).key
    await qc.invalidateQueries({ queryKey: ['recording-keys'] })
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}

async function turnOff(key: RecordingKeyDTO) {
  error.value = ''
  try {
    await api(`/api/me/recording-keys/${key.id}`, { method: 'DELETE' })
    if (created.value?.id === key.id) created.value = null
    await qc.invalidateQueries({ queryKey: ['recording-keys'] })
  }
  catch (cause) { error.value = errorMessage(cause) }
}
</script>

<template>
  <div>
    <p class="text-sm text-muted">Share a screen recording or screenshot from Photos, and it becomes a Task you can mark.</p>
    <UAlert v-if="error" class="mt-4" color="error" variant="subtle" :title="error" />

    <LayoutSegmentedTabs v-model="tab" :items="tabs" label="iPhone Shortcut" class="mt-4" />
    <div class="w-full">
      <template v-if="tab === 'install'">
        <ol class="mt-4 space-y-6">
          <li>
            <h2 class="font-medium text-highlighted">1. Make your link</h2>
            <p class="mt-1 text-sm text-muted">It can only send recordings<template v-if="canSwitch && activeSpace"> to {{ activeSpace.name }}</template>, and can’t read anything. Keep it to yourself: anyone who has it can send you recordings.</p>
            <template v-if="created">
              <p class="mt-3 text-xs font-medium text-warning">Shown once. Copy it now.</p>
              <code class="mt-1 block w-full break-all rounded bg-elevated p-2 font-mono text-xs">{{ personalLink }}</code>
              <UButton class="mt-2 w-full justify-center" icon="i-ph-copy" label="Copy the link" @click="copyValue(personalLink, 'Link')" />
            </template>
            <UButton v-else class="mt-3 w-full justify-center sm:w-auto" icon="i-ph-link" label="Make my link" :loading="busy" @click="makeKey" />
          </li>
          <li>
            <h2 class="font-medium text-highlighted">2. Add the Shortcut</h2>
            <p class="mt-1 text-sm text-muted">On the iPhone, open this page in Safari, download the Shortcut, and open it from the ↓ in the address bar. Tap <b>Set Up Shortcut</b> and paste your link.</p>
            <UButton class="mt-2 w-full justify-center sm:w-auto" :to="serverUrl('/L4.shortcut')" external download="L4.shortcut" icon="i-ph-download-simple" label="Get the Shortcut" color="neutral" variant="outline" />
            <details class="mt-3 rounded-lg border border-default p-3 text-sm">
              <summary class="cursor-pointer text-muted">Build it by hand instead</summary>
              <ol class="mt-3 list-decimal space-y-2 pl-5">
                <li>In <b>Shortcuts</b> tap <b>+</b>. Name it <b>L4</b>. In its details, turn on <b>Show in Share Sheet</b>.</li>
                <li>Add <b>Get Contents of URL</b> with your link. Tap <b>›</b>: <b>Method</b> POST; <b>Request Body</b> File, and choose <b>Shortcut Input</b>.</li>
                <li>Add <b>Open URLs</b>. Tap <b>Done</b>.</li>
              </ol>
            </details>
          </li>
          <li>
            <h2 class="font-medium text-highlighted">3. Sign in where links open</h2>
            <p class="mt-1 text-sm text-muted">The marking page opens in your phone’s default browser, usually Safari. Sign in to this Server there once, or it will ask you the first time.</p>
          </li>
          <li>
            <h2 class="font-medium text-highlighted">4. Share something</h2>
            <p class="mt-1 text-sm text-muted">In Photos, open a recording → <b>Share</b> → <b>L4</b>. The first time, iOS asks to send it to this Server: tap <b>Always Allow</b>.</p>
          </li>
        </ol>
      </template>
      <template v-else>
        <p v-if="!keysQ.data.value?.keys.length" class="mt-4 text-sm text-muted">No links yet. Make one under Install.</p>
        <ul v-else class="mt-2 divide-y divide-default">
          <li v-for="key in keysQ.data.value.keys" :key="key.id" class="flex items-center gap-3 py-2 text-sm">
            <div class="min-w-0 flex-1">
              <p class="truncate">{{ key.name }} <code class="font-mono text-xs text-muted">{{ key.tokenPrefix }}…</code></p>
              <p class="truncate text-xs text-muted">{{ canSwitch ? `${key.spaceName} · ` : '' }}{{ key.boardName ?? 'Shots' }}{{ key.lastUsedAt ? ` · last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : ' · not used yet' }}</p>
            </div>
            <UButton color="neutral" variant="ghost" size="xs" label="Turn off" @click="turnOff(key)" />
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

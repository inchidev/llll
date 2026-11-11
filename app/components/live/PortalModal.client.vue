<script setup lang="ts">
import type { OpenedPortal } from '~~/shared/portal'

/**
 * Open a Portal in this conversation (ADR 0014): a window of the caller's Mac, shared through the PartyPortal
 * app, with a link for one guest. The links are given out once; ending the Portal makes them stop working.
 */
const props = defineProps<{ channelId: string }>()
const open = defineModel<boolean>('open', { required: true })
const { api } = useApi()
const toast = useToast()

const portal = ref<OpenedPortal | null>(null)
const busy = ref(false)
const failed = ref('')

watch(open, (value) => {
  if (value && !portal.value && !busy.value) void start()
})

async function start() {
  busy.value = true
  failed.value = ''
  try {
    portal.value = await api<OpenedPortal>(`/api/channels/${props.channelId}/portals`, { method: 'POST' })
  }
  catch (error) {
    failed.value = (error as { data?: { error?: { message?: string } } })?.data?.error?.message || 'The Portal could not be opened.'
  }
  finally {
    busy.value = false
  }
}

async function copyGuestLink() {
  if (!portal.value) return
  try {
    await navigator.clipboard.writeText(portal.value.guestUrl)
    toast.add({ title: 'Guest link copied', color: 'success' })
  }
  catch {
    toast.add({ title: 'Copy failed', description: 'Select the link and copy it yourself.', color: 'error' })
  }
}

async function end() {
  if (!portal.value) return
  busy.value = true
  try {
    await api(`/api/channels/${props.channelId}/portals/${portal.value.portalId}`, { method: 'DELETE' })
    portal.value = null
    open.value = false
    toast.add({ title: 'Portal ended' })
  }
  catch {
    toast.add({ title: 'The Portal could not be ended', color: 'error' })
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Share a window" description="Show one window of your Mac to a guest. They can ask for control; your Mac asks you every time.">
    <template #body>
      <div class="space-y-4 text-sm">
        <p v-if="busy && !portal" class="text-muted">Opening a Portal…</p>
        <p v-else-if="failed" class="text-error">{{ failed }}</p>
        <template v-else-if="portal">
          <div class="space-y-1.5">
            <p class="font-medium">1. Open PartyPortal on this Mac</p>
            <p class="text-muted">It asks which window to share and connects it to this Portal.</p>
            <UButton :to="portal.hostLink" external icon="i-ph-app-window" label="Open PartyPortal" />
          </div>
          <div class="space-y-1.5">
            <p class="font-medium">2. Send this link to your guest</p>
            <p class="text-muted">Anyone with it can watch while the Portal is open. It works in any browser, without an account.</p>
            <div class="flex gap-2">
              <UInput :model-value="portal.guestUrl" readonly class="flex-1" aria-label="Guest link" @focus="($event.target as HTMLInputElement).select()" />
              <UButton color="neutral" variant="soft" icon="i-ph-copy" label="Copy" @click="copyGuestLink" />
            </div>
          </div>
          <p class="text-xs text-muted">
            The Portal ends when you end it, or on its own after twelve hours.
          </p>
        </template>
      </div>
    </template>
    <template #footer>
      <UButton color="neutral" variant="ghost" label="Close" @click="open = false" />
      <UButton v-if="portal" color="error" variant="soft" icon="i-ph-x-circle" label="End Portal" :loading="busy" @click="end" />
      <UButton v-else-if="failed" label="Try again" :loading="busy" @click="start" />
    </template>
  </UModal>
</template>

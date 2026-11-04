<script setup lang="ts">
import { useClipboard } from '@vueuse/core'

/** A Project invite: whoever opens it joins the Server and can act in this Project at once. */
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ projectId?: string; projectName?: string }>()
const { api, serverUrl } = useApi()
const { serverId } = useServer()
const { copy } = useClipboard()
const toast = useToast()
const url = ref('')
const busy = ref(false)
const failed = ref('')

watch(open, async (value) => {
  if (!value) return
  url.value = ''
  failed.value = ''
  busy.value = true
  try {
    const answer = await api<{ invite: { url: string } }>(`/api/servers/${serverId.value}/invites`, { method: 'POST', body: props.projectId ? { projectId: props.projectId, maxUses: 5, expiresInHours: 168 } : {} })
    url.value = serverUrl(answer.invite.url)
  }
  catch (error) { failed.value = errorMessage(error) }
  finally { busy.value = false }
})

async function copyLink() {
  await copy(url.value)
  toast.add({ title: 'Invite copied', color: 'success' })
}
</script>

<template>
  <UModal v-model:open="open" :title="projectName ? `Invite someone to ${projectName}` : 'Invite someone'" :description="projectId ? 'They join this Server and can see and add Tasks in this Project. The link works 5 times, for 7 days.' : 'Share this link. Anyone with it can join; give them access to a Project to see its Tasks.'">
    <template #body>
      <USkeleton v-if="busy" class="h-9" />
      <UAlert v-else-if="failed" color="error" variant="subtle" :title="failed" />
      <UInput v-else v-model="url" readonly class="w-full" aria-label="Invite link">
        <template #trailing><UButton size="xs" label="Copy" @click="copyLink" /></template>
      </UInput>
    </template>
  </UModal>
</template>

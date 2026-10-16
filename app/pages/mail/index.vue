<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { MailboxDTO, MemberDTO } from '~~/shared/types'
import { mailPath } from '~~/shared/paths'
import { WORKSPACE_ID } from '~~/shared/ids'
import { Permission } from '~~/shared/permissions'

definePageMeta({ layout: 'workspace', middleware: ['auth'] })

const { api } = useApi()

const mailboxesQ = useQuery({
  queryKey: ['mailboxes'],
  queryFn: () => api<{ mailboxes: MailboxDTO[] }>('/api/mail/mailboxes'),
})
const membersQ = useQuery({
  queryKey: ['members', WORKSPACE_ID],
  queryFn: () => api<{ members: MemberDTO[] }>(`/api/workspaces/${WORKSPACE_ID}/members`),
})
// People who manage mailboxes get the way to create one instead of "ask an admin".
const { can } = usePermissions(computed(() => membersQ.data.value?.members))
const canManageMail = computed(() => can(Permission.manageWorkspace))

watch(() => mailboxesQ.data.value?.mailboxes, (mailboxes) => {
  const first = mailboxes?.[0]
  if (first) void navigateTo(mailPath(first.channelId), { replace: true })
}, { immediate: true })
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <LayoutPageHeader icon="i-ph-envelope-simple" title="Mail" :loading="mailboxesQ.isPending.value" />
    <LayoutSkeleton v-if="mailboxesQ.isPending.value" variant="rows" :rows="6" />
    <LayoutEmptyState
      v-else-if="!mailboxesQ.data.value?.mailboxes.length"
      icon="i-ph-envelope-simple"
      :title="canManageMail ? 'No mailbox for you yet' : 'No mailbox assigned'"
      :description="canManageMail
        ? 'Create an address like support@, or give yourself access to an existing one, in Email settings.'
        : 'Ask a workspace admin for access to a mailbox.'"
    >
      <UButton v-if="canManageMail" icon="i-ph-gear" label="Set up email" :to="`/w/${WORKSPACE_ID}/settings?section=email`" />
    </LayoutEmptyState>
  </div>
</template>

<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { MailboxDTO } from '~~/shared/types'
import { MAIL_FOLDERS, mailPath } from '~~/shared/paths'

const route = useRoute()
const { api } = useApi()
const nav = useNavActions()

const mailboxesQ = useQuery({
  queryKey: ['mailboxes'],
  queryFn: () => api<{ mailboxes: MailboxDTO[] }>('/api/mail/mailboxes'),
  refetchInterval: 60_000,
})
const mailboxes = computed(() => mailboxesQ.data.value?.mailboxes ?? [])
const activeMailboxId = computed(() => String(route.params.mailbox || ''))
const activeFolder = computed(() => String(route.params.folder || 'inbox'))
const activeMailbox = computed(() => mailboxes.value.find(mailbox => mailbox.channelId === activeMailboxId.value) ?? null)
const canCompose = computed(() => activeMailbox.value?.permission === 'send' || activeMailbox.value?.permission === 'manage')

const folderMeta: Record<string, { label: string; icon: string }> = {
  inbox: { label: 'Inbox', icon: 'i-ph-tray' },
  sent: { label: 'Sent', icon: 'i-ph-paper-plane-tilt' },
  archive: { label: 'Archive', icon: 'i-ph-archive' },
  spam: { label: 'Spam', icon: 'i-ph-warning' },
  trash: { label: 'Trash', icon: 'i-ph-trash' },
}

async function compose() {
  if (activeMailboxId.value) nav.composeOpen.value = true
}
</script>

<template>
  <LayoutNavSection
    label="Mailboxes"
    collapse-key="mail:mailboxes"
    :create-label="canCompose ? 'Compose email' : undefined"
    @create="compose"
  >
    <LayoutSkeleton v-if="mailboxesQ.isPending.value" variant="nav" :rows="3" />
    <p v-else-if="!mailboxes.length" class="px-2 py-3 text-sm text-muted">
      No mailbox assigned yet.
    </p>
    <ul v-else>
      <li v-for="mailbox in mailboxes" :key="mailbox.channelId">
        <LayoutNavRow
          :to="mailPath(mailbox.channelId)"
          :ancestor="mailbox.channelId === activeMailboxId"
          :unread="Boolean(mailbox.unreadCount)"
        >
          <template #leading>
            <UIcon
              :name="mailbox.channelId === activeMailboxId ? 'i-ph-caret-down' : 'i-ph-caret-right'"
              class="size-3 shrink-0 text-dimmed"
            />
          </template>
          {{ mailbox.address }}
          <template #trailing>
            <UBadge
              v-if="mailbox.unreadCount && mailbox.channelId !== activeMailboxId"
              color="neutral"
              variant="subtle"
              size="sm"
              :label="mailbox.unreadCount > 99 ? '99+' : String(mailbox.unreadCount)"
            />
          </template>
        </LayoutNavRow>

        <ul v-if="mailbox.channelId === activeMailboxId" class="ms-4 border-s border-default ps-2">
          <li v-for="folder in MAIL_FOLDERS" :key="folder">
            <LayoutNavRow
              :to="mailPath(mailbox.channelId, folder)"
              :active="folder === activeFolder"
            >
              <template #leading>
                <UIcon :name="folderMeta[folder]!.icon" class="size-[18px] shrink-0 text-dimmed" />
              </template>
              {{ folderMeta[folder]!.label }}
              <template #trailing>
                <UBadge
                  v-if="folder === 'inbox' && mailbox.unreadCount"
                  color="primary"
                  variant="solid"
                  size="sm"
                  class="min-w-5 justify-center"
                  :label="mailbox.unreadCount > 99 ? '99+' : String(mailbox.unreadCount)"
                />
              </template>
            </LayoutNavRow>
          </li>
        </ul>
      </li>
    </ul>
  </LayoutNavSection>
</template>

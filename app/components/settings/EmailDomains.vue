<script setup lang="ts">
import type { MailSettingsDTO } from '~~/shared/types'

const props = defineProps<{
  serverId: string
  isOwner: boolean
  mail: MailSettingsDTO
}>()

function mailboxCount(domain: string) {
  const suffix = `@${domain.toLowerCase()}`
  return props.mail.mailboxes.filter(mailbox => mailbox.address.toLowerCase().endsWith(suffix)).length
}
</script>

<template>
  <div>
    <p class="text-sm text-muted">Domains this server sends and receives mail on.</p>
    <div v-if="!mail.domains.length" class="mt-3 rounded-lg border border-dashed border-default px-4 py-8 text-center">
      <UIcon name="i-ph-globe-simple" class="size-6 text-dimmed" />
      <p class="mt-2 text-sm font-medium text-highlighted">No email domains yet</p>
      <p class="mt-1 text-sm text-muted">Ask the server operator to configure an email domain.</p>
    </div>
    <ul v-else class="mt-3 divide-y divide-default overflow-hidden rounded-lg border border-default">
      <li v-for="domain in mail.domains" :key="domain.id" class="flex items-center gap-3 px-4 py-3">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted">
          <UIcon name="i-ph-globe-simple" class="size-4" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium text-highlighted">{{ domain.domain }}</span>
          <span class="block truncate text-xs text-muted">{{ mailboxCount(domain.domain) }} {{ mailboxCount(domain.domain) === 1 ? 'mailbox' : 'mailboxes' }}</span>
        </span>
      </li>
    </ul>
    <p class="mt-3 text-sm text-muted">Email domains are managed by the server operator. Contact them to add or remove a domain.</p>
  </div>
</template>

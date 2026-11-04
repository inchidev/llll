<script setup lang="ts">
import type { AttachmentDTO } from '~~/shared/types'
import { formatBytes } from '~~/shared/format'
import { MAIL_FILES_UNAVAILABLE, MAIL_OUTBOUND_LIMITS, mailAttachmentLimitError } from '~~/shared/mail-attachments'

/** Files on an email being written. Each is uploaded when picked and stays private until the email is sent. */
const props = defineProps<{ mailboxId: string; available: boolean }>()
const files = defineModel<AttachmentDTO[]>({ required: true })
const uploading = defineModel<number>('uploading', { default: 0 })

const { api, serverUrl } = useApi()
const toast = useToast()
const input = ref<HTMLInputElement | null>(null)
const total = computed(() => files.value.reduce((sum, file) => sum + file.sizeBytes, 0))

async function upload(list: FileList | null) {
  const picked = [...(list ?? [])]
  if (input.value) input.value.value = ''
  const limit = mailAttachmentLimitError([...files.value, ...picked.map(file => ({ sizeBytes: file.size }))])
  if (limit) { toast.add({ title: limit, color: 'error' }); return }
  uploading.value += picked.length
  await Promise.all(picked.map(async (file) => {
    try {
      const form = new FormData()
      form.append('file', file)
      const result = await api<{ attachment: AttachmentDTO }>(`/api/mail/mailboxes/${props.mailboxId}/attachments`, { method: 'POST', body: form })
      files.value = [...files.value, result.attachment]
    }
    catch (error) { toast.add({ title: `${file.name}: ${errorMessage(error)}`, color: 'error' }) }
    finally { uploading.value -= 1 }
  }))
}

function remove(file: AttachmentDTO) {
  files.value = files.value.filter(item => item.id !== file.id)
  void api(`/api/mail/mailboxes/${props.mailboxId}/attachments`, { method: 'DELETE', body: { attachmentId: file.id } }).catch(() => {})
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <UTooltip :text="available ? `Up to ${MAIL_OUTBOUND_LIMITS.attachments} files, ${formatBytes(MAIL_OUTBOUND_LIMITS.attachmentBytes)} in total` : MAIL_FILES_UNAVAILABLE">
      <UButton icon="i-ph-paperclip" label="Attach" size="xs" color="neutral" variant="ghost" :disabled="!available" :loading="uploading > 0" @click="input?.click()" />
    </UTooltip>
    <input ref="input" type="file" multiple class="hidden" @change="upload(($event.target as HTMLInputElement).files)">
    <span v-for="file in files" :key="file.id" class="inline-flex max-w-full items-center gap-1 rounded-md bg-elevated px-2 py-1 text-xs">
      <UIcon name="i-ph-file" class="size-3.5 shrink-0 text-dimmed" />
      <a :href="serverUrl(file.url)" target="_blank" class="truncate text-default hover:underline">{{ file.filename }}</a>
      <span class="shrink-0 text-muted">{{ formatBytes(file.sizeBytes) }}</span>
      <UButton icon="i-ph-x" size="xs" color="neutral" variant="link" square :aria-label="`Remove ${file.filename}`" @click="remove(file)" />
    </span>
    <span v-if="files.length > 1" class="text-xs text-muted">{{ formatBytes(total) }}</span>
  </div>
</template>

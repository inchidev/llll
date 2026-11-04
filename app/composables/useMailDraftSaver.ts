import { useQueryClient } from '@tanstack/vue-query'
import type { MailDraftDTO } from '~~/shared/types'

export type MailDraftBody = Omit<MailDraftDTO, 'id' | 'mailboxChannelId' | 'threadSubject' | 'attachments' | 'updatedAt'> & { attachmentIds: string[] }

/**
 * Saves one composer's draft a second after typing stops, one request at a time.
 * Each draft being written is a slot: `reset` starts a new one while earlier
 * saves finish against their own draft. A body of null discards the draft.
 */
export function useMailDraftSaver(mailboxId: MaybeRefOrGetter<string | null>) {
  const { api } = useApi()
  const qc = useQueryClient()
  let slot = { id: null as string | null }
  /** The current draft's id once it is saved. */
  const savedId = ref<string | null>(null)
  const assign = (target: typeof slot, id: string | null) => {
    target.id = id
    if (target === slot) savedId.value = id
  }
  let pending: (() => MailDraftBody | null) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()

  function cache(mailbox: string, update: (drafts: MailDraftDTO[]) => MailDraftDTO[]) {
    qc.setQueryData<{ drafts: MailDraftDTO[] }>(['mail-drafts', mailbox], data => data && { drafts: update(data.drafts) })
  }

  function schedule(body: () => MailDraftBody | null) {
    pending = body
    clearTimeout(timer)
    timer = setTimeout(() => void flush(), 1000)
  }

  function flush(): Promise<void> {
    clearTimeout(timer)
    const read = pending
    pending = null
    const mailbox = toValue(mailboxId)
    if (!read || !mailbox) return chain
    const body = read()
    const target = slot
    chain = chain.then(async () => {
      if (!body) {
        if (!target.id) return
        const draftId = target.id
        assign(target, null)
        await api(`/api/mail/mailboxes/${mailbox}/drafts`, { method: 'DELETE', body: { draftId } })
        cache(mailbox, drafts => drafts.filter(draft => draft.id !== draftId))
        return
      }
      const save = () => api<{ draft: MailDraftDTO }>(`/api/mail/mailboxes/${mailbox}/drafts`, { method: 'PUT', body: { ...body, id: target.id ?? undefined } })
      // A draft sent or discarded elsewhere is saved again as a new one.
      const { draft } = await save().catch((error: { statusCode?: number }) => {
        if (error?.statusCode !== 404 || !target.id) throw error
        assign(target, null)
        return save()
      })
      assign(target, draft.id)
      cache(mailbox, drafts => [draft, ...drafts.filter(item => item.id !== draft.id)])
    }).catch(() => {})
    return chain
  }

  /** Saves what is pending and waits for every save so far. */
  async function settle() {
    await flush()
    return slot.id
  }

  /** Starts a new draft, optionally continuing a saved one. Pending changes are dropped: flush first to keep them. */
  function reset(id: string | null = null) {
    clearTimeout(timer)
    pending = null
    slot = { id }
    savedId.value = id
  }

  /** Discards the current draft on the server. */
  function discard() {
    pending = () => null
    return flush()
  }

  return { schedule, flush, settle, reset, discard, savedId: readonly(savedId) }
}

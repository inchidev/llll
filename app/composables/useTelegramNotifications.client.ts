type TelegramReply = { token: string; relayOrigin: string } | { error: string }

/** What the Telegram Shell embedding this Client offers; filled by the embed plugin. */
export function useTelegramEmbed() {
  return useState('llll-telegram-embed', () => ({
    available: false,
    reply: null as TelegramReply | null,
    request: null as (() => void) | null,
  }))
}

/**
 * Telegram notifications for this Account, offered only when a Telegram Shell embeds the
 * Server. The Shell asks Telegram for permission and returns an opaque delivery token,
 * which this Server stores like a push subscription.
 */
export function useTelegramNotifications() {
  const embed = useTelegramEmbed()
  const available = computed(() => embed.value.available)
  const subscribed = ref(false)
  const busy = ref(false)
  const error = ref<string | null>(null)

  async function refresh() {
    if (!available.value) return
    try { subscribed.value = (await plainFetch<{ subscribed: boolean }>('/api/push/telegram')).subscribed }
    catch (cause) { error.value = errorMessage(cause) }
  }

  async function enable() {
    if (!embed.value.request) return
    busy.value = true
    error.value = null
    embed.value.reply = null
    try {
      embed.value.request()
      const reply = await new Promise<TelegramReply>((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error('Telegram did not answer. Try again.')) }, 120_000)
        const stop = watch(() => embed.value.reply, (value) => {
          if (!value) return
          clearTimeout(timer); stop(); resolve(value)
        })
      })
      if ('error' in reply) throw new Error(reply.error)
      await plainFetch('/api/push/telegram', { method: 'PUT', body: reply })
      subscribed.value = true
    }
    catch (cause) { error.value = errorMessage(cause) }
    finally { busy.value = false }
  }

  async function disable() {
    busy.value = true
    error.value = null
    try {
      await plainFetch('/api/push/telegram', { method: 'DELETE' })
      subscribed.value = false
    }
    catch (cause) { error.value = errorMessage(cause) }
    finally { busy.value = false }
  }

  watch(available, value => { if (value) void refresh() })
  return { available, subscribed, busy, error, refresh, enable, disable }
}

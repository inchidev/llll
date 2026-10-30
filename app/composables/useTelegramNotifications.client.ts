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
 * Telegram notifications for this Account. In Telegram, the Shell (or this Server's own Mini
 * App) asks Telegram for permission and returns an opaque delivery token. In a browser, the
 * person presses Start on the L4 bot with a one-time code and this Server collects the token.
 * Either way the Server stores it like a push subscription.
 */
export function useTelegramNotifications() {
  const embed = useTelegramEmbed()
  const available = computed(() => embed.value.available)
  const subscribed = ref(false)
  const busy = ref(false)
  const error = ref<string | null>(null)

  async function refresh() {
    try { subscribed.value = (await plainFetch<{ subscribed: boolean }>('/api/push/telegram')).subscribed }
    catch (cause) { error.value = errorMessage(cause) }
  }

  async function enable() {
    if (!embed.value.request) return pair()
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

  /** Opens the bot from the click itself, so the browser does not block it, then waits for Start. */
  async function pair() {
    busy.value = true
    error.value = null
    const tab = window.open('about:blank', '_blank')
    try {
      const { code, url } = await plainFetch<{ code: string; url: string }>('/api/push/telegram/link', { method: 'POST' })
      if (tab) tab.location.href = url
      else window.location.href = url
      const until = Date.now() + 10 * 60_000
      while (Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 2000))
        if (document.hidden) continue
        if ((await plainFetch<{ connected: boolean }>('/api/push/telegram/claim', { method: 'POST', body: { code } })).connected) {
          subscribed.value = true
          return
        }
      }
      throw new Error('Telegram did not answer. Try again.')
    }
    catch (cause) {
      tab?.close()
      error.value = errorMessage(cause)
    }
    finally { busy.value = false }
  }

  watch(available, value => { if (value) void refresh() })
  return { available, subscribed, busy, error, refresh, enable, disable }
}

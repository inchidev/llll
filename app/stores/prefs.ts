import { defineStore } from 'pinia'
import { useSafeLocalStorage } from '../composables/useSafeLocalStorage'

export const usePrefsStore = defineStore('prefs', () => {
  const compact = import.meta.client ? useSafeLocalStorage('df:compact', false) : ref(false)
  const messageSounds = import.meta.client ? useSafeLocalStorage('df:sounds', true) : ref(true)
  const callRingtone = import.meta.client ? useSafeLocalStorage('df:call-ringtone', true) : ref(true)
  const showOnline = import.meta.client ? useSafeLocalStorage('df:showOnline', true) : ref(true)
  const recentEmoji = import.meta.client
    ? useSafeLocalStorage<string[]>('df:recent-emoji', [])
    : ref<string[]>([])

  function useEmoji(emoji: string) {
    const current = Array.isArray(recentEmoji.value) ? recentEmoji.value : []
    recentEmoji.value = [emoji, ...current.filter(item => item !== emoji)].slice(0, 24)
  }

  return { compact, messageSounds, callRingtone, showOnline, recentEmoji, useEmoji }
})

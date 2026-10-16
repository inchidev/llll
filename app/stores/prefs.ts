import { defineStore } from 'pinia'
import { useLocalStorage } from '@vueuse/core'

export const usePrefsStore = defineStore('prefs', () => {
  const compact = import.meta.client ? useLocalStorage('df:compact', false) : ref(false)
  const messageSounds = import.meta.client ? useLocalStorage('df:sounds', true) : ref(true)
  const showOnline = import.meta.client ? useLocalStorage('df:showOnline', true) : ref(true)
  const recentEmoji = import.meta.client
    ? useLocalStorage<string[]>('df:recent-emoji', [])
    : ref<string[]>([])

  function useEmoji(emoji: string) {
    const current = Array.isArray(recentEmoji.value) ? recentEmoji.value : []
    recentEmoji.value = [emoji, ...current.filter(item => item !== emoji)].slice(0, 24)
  }

  return { compact, messageSounds, showOnline, recentEmoji, useEmoji }
})

<script setup lang="ts">
const live = useLiveStore()
const prefs = usePrefsStore()

const now = ref(Date.now())
const secondsLeft = computed(() => live.incoming ? Math.max(0, Math.ceil((live.incoming.ringUntil - now.value) / 1000)) : 0)
/** Answering from another room leaves it; say so before it happens. */
const leavesRoom = computed(() => Boolean(live.incoming && live.currentChannelId && live.currentChannelId !== live.incoming.channelId))

let clock: ReturnType<typeof setInterval> | null = null
let ringer: ReturnType<typeof setInterval> | null = null
let audio: AudioContext | null = null

/** Two short tones, like a phone ring, without shipping an audio file. */
function ringOnce() {
  try {
    audio ??= new AudioContext()
    const context = audio
    for (const [offset, frequency] of [[0, 440], [0.45, 480]] as const) {
      const start = context.currentTime + offset
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(start)
      oscillator.stop(start + 0.42)
    }
  }
  catch { /* autoplay policy can reject audio before the first user gesture */ }
  try { navigator.vibrate?.([400, 200, 400]) }
  catch { /* vibration is optional */ }
}

function stopRinging() {
  if (clock) clearInterval(clock)
  if (ringer) clearInterval(ringer)
  clock = ringer = null
  try { navigator.vibrate?.(0) }
  catch { /* vibration is optional */ }
  void audio?.close().catch(() => undefined)
  audio = null
}

watch(() => live.incoming, (call) => {
  stopRinging()
  if (!call) return
  now.value = Date.now()
  clock = setInterval(() => {
    now.value = Date.now()
    // The server ends an unanswered Call; stop ringing here at the same moment.
    if (live.incoming && now.value >= live.incoming.ringUntil) live.ignoreIncoming()
  }, 1000)
  if (prefs.callRingtone) {
    ringOnce()
    ringer = setInterval(ringOnce, 3000)
  }
}, { immediate: true })
onUnmounted(stopRinging)
</script>

<template>
  <UModal
    :open="Boolean(live.incoming)"
    :ui="{ content: 'sm:max-w-sm' }"
    @update:open="(open) => { if (!open) live.ignoreIncoming() }"
  >
    <template #content>
      <div v-if="live.incoming" class="p-6 text-center" role="alertdialog" aria-labelledby="incoming-call-title" aria-describedby="incoming-call-body">
        <div class="mx-auto grid size-16 place-items-center rounded-full bg-success/15 text-success">
          <UIcon name="i-ph-phone-incoming" class="size-8 animate-pulse" />
        </div>
        <h2 id="incoming-call-title" class="mt-4 text-lg font-semibold text-highlighted">{{ live.incoming.title }}</h2>
        <p id="incoming-call-body" class="mt-1 text-sm text-muted">{{ live.incoming.body }}</p>
        <p class="mt-2 text-xs text-muted" aria-live="off">Stops ringing in {{ secondsLeft }} s</p>
        <UAlert
          v-if="leavesRoom"
          class="mt-4 text-start"
          color="warning"
          variant="subtle"
          icon="i-ph-warning"
          :title="`Answering leaves ${live.currentTitle || 'your current live session'}`"
        />
        <div class="mt-6 flex justify-center gap-3">
          <UButton
            color="error"
            variant="soft"
            icon="i-ph-phone-disconnect"
            label="Decline"
            @click="live.declineIncoming()"
          />
          <UButton color="success" icon="i-ph-phone" :label="leavesRoom ? 'Leave and answer' : 'Answer'" @click="live.answerIncoming()" />
        </div>
        <UButton class="mt-3" color="neutral" variant="link" size="sm" label="Ignore" @click="live.ignoreIncoming()" />
      </div>
    </template>
  </UModal>
</template>

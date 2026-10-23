<script setup lang="ts">
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

const open = defineModel<boolean>('open', { default: false })
/** Exposed so `/settings?section=…` can deep-link, and so the section survives reopening. */
const section = defineModel<string>('section', { default: 'account' })

const session = useSessionStore()
const { server, serverId } = useServer()
const isOwner = computed(() => Boolean(server.value && server.value.ownerId === session.user?.id))
const { api } = useApi()
const live = useLiveStore()
const prefs = usePrefsStore()
const push = usePushNotifications()
const presence = usePresenceStore()
const toast = useToast()
const colorMode = useColorMode()
const recoveryCode = ref('')
const recoveryBusy = ref(false)
async function replaceRecoveryKey() {
  recoveryBusy.value = true
  try { recoveryCode.value = (await api<{ code: string }>('/api/auth/recovery-key', { method: 'POST' })).code } catch (cause) { toast.add({ title: errorMessage(cause), color: 'error' }) } finally { recoveryBusy.value = false }
}
const revealEmail = ref(false)
const confirmLogout = ref(false)
const savingName = ref(false)
const accountProviders = ref<string[]>([])
const hasPassword = computed(() => accountProviders.value.includes('credential'))

const schema = z.object({ displayName: z.string().min(1).max(80) })
type Schema = z.output<typeof schema>
const state = reactive<Partial<Schema>>({ displayName: session.user?.displayName || '' })

const password = reactive({ current: '', next: '', confirm: '' })
const savingPassword = ref(false)
const passwordError = computed(() => {
  if (password.next && password.next.length < 8) return 'Use at least 8 characters.'
  if (password.confirm && password.next !== password.confirm) return 'The two new passwords do not match.'
  return ''
})
const canSavePassword = computed(() => Boolean(
  password.current && password.next.length >= 8 && password.next === password.confirm,
))
const avatarInput = ref<HTMLInputElement | null>(null)
const avatarBusy = ref(false)
const avatarDragging = ref(false)
const avatarAccept = AVATAR_ACCEPT
const hasAvatar = computed(() => Boolean(session.user && userAvatarSrc(session.user)))
const presenceLabel = computed(() => {
  const status = session.user ? presence.statusOf(session.user.id) : 'offline'
  if (!prefs.showOnline) return 'Activity hidden'
  return status === 'online' ? 'Online' : status === 'idle' ? 'Idle' : 'Offline'
})
const nameChanged = computed(() => (state.displayName || '') !== (session.user?.displayName || ''))

const inputId = ref('')
const outputId = ref('')
const inputs = ref<{ label: string; value: string }[]>([])
const outputs = ref<{ label: string; value: string }[]>([])
const micBusy = ref(false)

watch(open, async (v) => {
  if (v) {
    state.displayName = session.user?.displayName || ''
    password.current = ''
    password.next = ''
    password.confirm = ''
    revealEmail.value = false
    try {
      accountProviders.value = (await api<{ providers: string[] }>('/api/auth/accounts')).providers
    }
    catch {
      accountProviders.value = []
    }
    await push.refresh()
  }
})

const groups = computed(() => [
  {
    label: 'User Settings',
    items: [
      { id: 'account', label: 'My Account', icon: 'i-ph-user-circle', keywords: ['password', 'email', 'security', 'login'] },
      { id: 'profile', label: 'Profile', icon: 'i-ph-identification-card', keywords: ['display name', 'avatar', 'nickname'] },
      { id: 'privacy', label: 'Privacy & Safety', icon: 'i-ph-shield-check', keywords: ['online status', 'activity', 'presence'] },
      { id: 'connections', label: 'Connected apps', icon: 'i-ph-plugs-connected', keywords: ['mcp', 'oauth', 'codex', 'claude', 'access', 'revoke'] },
      ...(isOwner.value ? [{ id: 'mcp', label: 'Access tokens', icon: 'i-ph-key', keywords: ['mcp', 'manual', 'token', 'codex', 'agent'] }] : []),
    ],
  },
  {
    label: 'App Settings',
    items: [
      { id: 'appearance', label: 'Appearance', icon: 'i-ph-paint-brush', keywords: ['theme', 'dark mode', 'light mode', 'compact'] },
      { id: 'notifications', label: 'Notifications', icon: 'i-ph-bell', keywords: ['push', 'sounds', 'alerts', 'mentions'] },
      { id: 'voice', label: 'Voice & Video', icon: 'i-ph-microphone', keywords: ['mic', 'live', 'call', 'audio', 'camera', 'devices'] },
      { id: 'chat', label: 'Chat', icon: 'i-ph-chat-circle-text', keywords: ['markdown', 'shortcuts', 'send message'] },
    ],
  },
])

/** A bad or stale ?section= falls back to the first item rather than rendering nothing. */
watch([open, () => section.value], ([isOpen]) => {
  if (!isOpen) return
  const known = groups.value.flatMap(group => group.items).some(item => item.id === section.value)
  if (!known) section.value = 'account'
}, { immediate: true })

const previewUser = computed(() => session.user
  ? { ...session.user, displayName: state.displayName?.trim() || session.user.displayName }
  : null)
const email = computed(() => session.user?.email || '')
const maskedEmail = computed(() => {
  const [name, domain] = email.value.split('@')
  if (!name || !domain) return email.value
  return `${name[0]}${'*'.repeat(Math.max(name.length - 1, 4))}@${domain}`
})

const theme = computed({
  get: () => colorMode.preference || 'dark',
  set: (v: string) => { colorMode.preference = v },
})

const themes = [
  { label: 'Dark', value: 'dark', description: 'Default L4 look' },
  { label: 'Light', value: 'light', description: 'Bright surfaces' },
  { label: 'Sync with computer', value: 'system', description: 'Match the OS' },
]

async function onSaveName(event: FormSubmitEvent<Schema>) {
  savingName.value = true
  try {
    const res = await api<{ user: { displayName: string } }>('/api/me', { method: 'PATCH', body: event.data })
    if (session.user) session.user.displayName = res.user.displayName
    toast.add({ title: 'Display name updated', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    savingName.value = false
  }
}

async function uploadAvatar(file: File | undefined) {
  if (!file || avatarBusy.value || session.health?.bindings.r2 === false) return
  avatarBusy.value = true
  try {
    const image = await prepareAvatarImage(file)
    const form = new FormData()
    form.append('file', image, file.name)
    const res = await api<{ avatarR2Key: string }>('/api/me/avatar', { method: 'PUT', body: form })
    if (session.user) session.user.avatarR2Key = res.avatarR2Key
    toast.add({ title: 'Avatar updated', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    avatarBusy.value = false
    if (avatarInput.value) avatarInput.value.value = ''
  }
}

function onAvatarDrop(event: DragEvent) {
  avatarDragging.value = false
  void uploadAvatar(event.dataTransfer?.files[0])
}

async function removeAvatar() {
  avatarBusy.value = true
  try {
    await api('/api/me/avatar', { method: 'DELETE' })
    if (session.user) session.user.avatarR2Key = null
    toast.add({ title: 'Avatar removed', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    avatarBusy.value = false
  }
}

async function onPassword() {
  if (password.next.length < 8) {
    toast.add({ title: 'New password must be at least 8 characters', color: 'error' })
    return
  }
  if (password.next !== password.confirm) {
    toast.add({ title: 'New passwords do not match', color: 'error' })
    return
  }
  savingPassword.value = true
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: password.current, newPassword: password.next },
    })
    toast.add({ title: 'Password updated', color: 'success' })
    password.current = ''
    password.next = ''
    password.confirm = ''
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    savingPassword.value = false
  }
}

async function enableNotifications() {
  try {
    await push.enable()
    if (push.status.value === 'subscribed') toast.add({ title: 'Notifications enabled', color: 'success' })
    else if (push.status.value === 'blocked') toast.add({ title: 'Permission denied', color: 'warning' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
}

async function disableNotifications() {
  try {
    await push.disable()
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
}

async function loadDevices() {
  micBusy.value = true
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true })
    const list = await navigator.mediaDevices.enumerateDevices()
    inputs.value = list.filter((d) => d.kind === 'audioinput').map((d, i) => ({
      label: d.label || `Microphone ${i + 1}`,
      value: d.deviceId || `in-${i}`,
    }))
    outputs.value = list.filter((d) => d.kind === 'audiooutput').map((d, i) => ({
      label: d.label || `Speaker ${i + 1}`,
      value: d.deviceId || `out-${i}`,
    }))
    if (!inputId.value && inputs.value[0]) inputId.value = inputs.value[0].value
    if (!outputId.value && outputs.value[0]) outputId.value = outputs.value[0].value
  }
  catch {
    toast.add({ title: 'Microphone permission is required to list devices', color: 'warning' })
  }
  finally {
    micBusy.value = false
  }
}

async function logout() {
  await push.disable().catch(() => undefined)
  const redirect = await session.logout(api)
  open.value = false
  if (redirect) {
    window.location.assign(redirect)
    return
  }
  await navigateTo('/login')
}
</script>

<template>
  <SettingsOverlay v-model:open="open" v-model:section="section" :groups="groups" :title="session.user?.displayName || 'Account'">
    <template #footer>
      <UButton
        label="Log Out"
        icon="i-ph-sign-out"
        color="error"
        variant="ghost"
        block
        class="justify-start"
        @click="confirmLogout = true"
      />
    </template>

    <template v-if="section === 'account'">
      <h1 class="text-xl font-semibold text-highlighted mb-5">My Account</h1>
      <div class="rounded-lg overflow-hidden bg-elevated ring ring-default">
        <div class="h-[100px] bg-accented" />
        <div class="relative px-4 pb-4">
          <button
            type="button"
            class="absolute -top-10 start-4 rounded-full ring-8 ring-[var(--ui-bg-elevated)] focus-visible:outline-2 focus-visible:outline-primary"
            aria-label="Change avatar"
            @click="section = 'profile'"
          >
            <UserAvatar v-if="session.user" :user="session.user" size="3xl" />
          </button>
          <div class="flex items-start justify-between gap-3 pt-2 ps-[88px] min-h-12">
            <p class="text-xl font-bold text-highlighted truncate">{{ session.user?.displayName }}</p>
            <UButton size="sm" label="Edit User Profile" class="shrink-0" @click="section = 'profile'" />
          </div>
          <div class="mt-4 rounded-lg bg-muted p-4 space-y-4">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-[11px] font-bold uppercase tracking-wide text-muted">Display Name</p>
                <p class="text-sm text-highlighted truncate">{{ session.user?.displayName }}</p>
              </div>
              <UButton size="xs" color="neutral" variant="soft" label="Edit" @click="section = 'profile'" />
            </div>
            <USeparator v-if="email" />
            <div v-if="email" class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-[11px] font-bold uppercase tracking-wide text-muted">Email</p>
                <p class="text-sm text-highlighted truncate">{{ revealEmail ? email : maskedEmail }}</p>
              </div>
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                :label="revealEmail ? 'Hide' : 'Reveal'"
                @click="revealEmail = !revealEmail"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="mt-8 max-w-sm space-y-3"><h2 class="text-sm font-semibold">Account recovery</h2><p class="text-sm text-muted">Save a recovery key for this Server. It lets you set a new password without email delivery. Replacing the key invalidates the previous one.</p><UButton label="Replace recovery key" color="neutral" variant="outline" :loading="recoveryBusy" @click="replaceRecoveryKey" /><UAlert v-if="recoveryCode" title="Save this key now" :description="recoveryCode" color="warning" /></div>
      <h2 v-if="hasPassword" class="mt-10 text-xs font-bold uppercase tracking-wide text-muted">Password and Authentication</h2>
      <div v-if="hasPassword" class="mt-3 max-w-sm space-y-3">
        <UFormField label="Current password">
          <FormPasswordInput v-model="password.current" class="w-full" autocomplete="current-password" />
        </UFormField>
        <UFormField label="New password" hint="At least 8 characters">
          <FormPasswordInput v-model="password.next" class="w-full" autocomplete="new-password" />
        </UFormField>
        <UFormField
          label="Confirm new password"
          :error="passwordError || undefined"
        >
          <FormPasswordInput v-model="password.confirm" class="w-full" autocomplete="new-password" />
        </UFormField>
        <UButton
          label="Change Password"
          :loading="savingPassword"
          :disabled="!canSavePassword"
          @click="onPassword"
        />
      </div>
    </template>

    <template v-else-if="section === 'connections'">
      <SettingsMcpConnections />
    </template>

    <template v-else-if="section === 'mcp' && isOwner">
      <SettingsMcpSettings :server-id="serverId" />
    </template>

    <template v-else-if="section === 'profile'">
      <h1 class="text-xl font-semibold text-highlighted mb-5">Profile</h1>
      <div class="grid gap-8 lg:grid-cols-[1fr_320px]">
        <div class="space-y-8 min-w-0">
          <section>
            <h2 class="text-xs font-bold uppercase tracking-wide text-muted mb-3">Avatar</h2>
            <div class="flex items-center gap-4">
              <button
                type="button"
                class="group relative shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                :class="avatarDragging ? 'outline-2 outline-offset-2 outline-primary' : ''"
                :disabled="avatarBusy"
                aria-label="Upload avatar"
                @click="avatarInput?.click()"
                @dragover.prevent="avatarDragging = true"
                @dragleave="avatarDragging = false"
                @drop.prevent="onAvatarDrop"
              >
                <UserAvatar v-if="session.user" :user="session.user" size="3xl" />
                <span
                  class="absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-white transition-opacity"
                  :class="avatarBusy || avatarDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'"
                >
                  <UIcon :name="avatarBusy ? 'i-ph-spinner-gap' : 'i-ph-camera'" class="size-6" :class="avatarBusy ? 'animate-spin' : ''" />
                </span>
              </button>
              <div class="min-w-0 space-y-2">
                <div class="flex flex-wrap gap-2">
                  <UButton size="sm" :label="hasAvatar ? 'Change Avatar' : 'Upload Avatar'" :loading="avatarBusy" :disabled="session.health?.bindings.r2 === false" @click="avatarInput?.click()" />
                  <UButton
                    v-if="hasAvatar"
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    label="Remove"
                    :disabled="avatarBusy"
                    @click="removeAvatar"
                  />
                </div>
                <p class="text-xs text-muted">PNG, JPEG, WebP, or GIF up to 2 MB. Images are cropped to a centered square.</p>
              </div>
              <input
                ref="avatarInput"
                type="file"
                class="hidden"
                :accept="avatarAccept"
                @change="uploadAvatar(($event.target as HTMLInputElement).files?.[0])"
              >
            </div>
          </section>
          <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSaveName">
            <UFormField name="displayName" label="Display Name" :hint="`${state.displayName?.length ?? 0}/80`">
              <UInput v-model="state.displayName" class="w-full" :maxlength="80" />
            </UFormField>
            <p class="text-sm text-muted">This is how you appear in channels, DMs, and live sessions.</p>
            <div class="flex gap-2">
              <UButton type="submit" label="Save Changes" :loading="savingName" :disabled="!nameChanged || !state.displayName?.trim()" />
              <UButton
                v-if="nameChanged"
                color="neutral"
                variant="ghost"
                label="Reset"
                @click="state.displayName = session.user?.displayName || ''"
              />
            </div>
          </UForm>
        </div>
        <div>
          <p class="text-[11px] font-bold uppercase tracking-wide text-muted mb-2">Preview</p>
          <div class="rounded-lg overflow-hidden bg-elevated ring ring-default">
            <div class="h-20 bg-accented" />
            <div class="px-4 pb-4">
              <div class="rounded-full ring-8 ring-[var(--ui-bg-elevated)] -mt-8 w-fit">
                <UserAvatar v-if="previewUser" :user="previewUser" size="xl" />
              </div>
              <p class="mt-3 text-lg font-bold text-highlighted truncate">{{ previewUser?.displayName }}</p>
              <p v-if="email" class="text-sm text-muted truncate">{{ email }}</p>
              <USeparator class="my-3" />
              <p class="text-[11px] font-bold uppercase tracking-wide text-muted">Status</p>
              <p class="text-sm text-muted mt-1">{{ presenceLabel }}</p>
            </div>
          </div>
          <p class="mt-3 text-xs text-muted">Sample message</p>
          <div class="mt-1 flex items-start gap-3 rounded-lg bg-muted p-3">
            <UserAvatar v-if="previewUser" :user="previewUser" size="md" />
            <div class="min-w-0">
              <p class="text-sm font-semibold text-highlighted truncate">{{ previewUser?.displayName }}</p>
              <p class="text-sm text-default">Hey team, new look!</p>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="section === 'privacy'">
      <h1 class="text-xl font-semibold text-highlighted">Privacy & Safety</h1>
      <div class="mt-8 divide-y divide-default">
        <div class="flex items-start justify-between gap-6 py-4">
          <div>
            <p class="font-medium text-highlighted">Display current activity</p>
            <p class="text-sm text-muted mt-1">Show Online / Idle / Offline on the member list.</p>
          </div>
          <USwitch v-model="prefs.showOnline" aria-label="Display current activity" />
        </div>
      </div>
    </template>

    <template v-else-if="section === 'appearance'">
      <h1 class="text-xl font-semibold text-highlighted">Appearance</h1>
      <p class="mt-1 text-sm text-muted">How L4 looks on this device.</p>
      <h2 class="mt-8 mb-3 text-xs font-bold uppercase tracking-wide text-muted">Theme</h2>
      <URadioGroup v-model="theme" variant="card" :items="themes" />
      <h2 class="mt-8 mb-3 text-xs font-bold uppercase tracking-wide text-muted">Message Display</h2>
      <div class="flex items-start justify-between gap-6 py-2">
        <div>
          <p class="font-medium text-highlighted">Compact mode</p>
          <p class="text-sm text-muted mt-1">Tighter message spacing. Consecutive messages still group together.</p>
        </div>
        <USwitch v-model="prefs.compact" aria-label="Compact mode" />
      </div>
    </template>

    <template v-else-if="section === 'notifications'">
      <h1 class="text-xl font-semibold text-highlighted">Notifications</h1>
      <div class="mt-8 divide-y divide-default">
        <div class="flex items-start justify-between gap-6 py-4">
          <div>
            <p class="font-medium text-highlighted">Push notifications</p>
            <p class="text-sm text-muted mt-1">Mentions, direct messages, and new live sessions on this device.</p>
          </div>
          <UButton
            v-if="push.status.value === 'prompt' || push.status.value === 'error'"
            size="sm"
            label="Enable"
            :loading="push.busy.value"
            @click="enableNotifications"
          />
          <USwitch
            v-else-if="push.status.value === 'subscribed'"
            :model-value="true"
            aria-label="Push notifications"
            :disabled="push.busy.value"
            @update:model-value="disableNotifications"
          />
          <UBadge
            v-else
            color="neutral"
            variant="soft"
            :label="push.status.value === 'blocked' ? 'Blocked' : push.status.value === 'unconfigured' ? 'Unavailable' : 'Unsupported'"
          />
        </div>
        <div class="flex items-start justify-between gap-6 py-4">
          <div>
            <p class="font-medium text-highlighted">Message sounds</p>
            <p class="text-sm text-muted mt-1">Play a sound when a message arrives while the tab is in the background.</p>
          </div>
          <USwitch v-model="prefs.messageSounds" aria-label="Message sounds" />
        </div>
      </div>
    </template>

    <template v-else-if="section === 'voice'">
      <h1 class="text-xl font-semibold text-highlighted">Voice & Video</h1>
      <p class="mt-1 text-sm text-muted">Live sessions use your browser microphone. Mute and deafen also live on the account panel.</p>
      <div class="mt-8 space-y-6 max-w-md">
        <div class="flex gap-2">
          <UButton
            :color="live.muted ? 'error' : 'neutral'"
            :variant="live.muted ? 'soft' : 'outline'"
            :icon="live.muted ? 'i-ph-microphone-slash' : 'i-ph-microphone'"
            :label="live.muted ? 'Unmute' : 'Mute'"
            @click="live.toggleMute()"
          />
          <UButton
            :color="live.deafened ? 'error' : 'neutral'"
            :variant="live.deafened ? 'soft' : 'outline'"
            :icon="live.deafened ? 'i-ph-speaker-slash' : 'i-ph-headphones'"
            :label="live.deafened ? 'Undeafen' : 'Deafen'"
            @click="live.toggleDeafen()"
          />
        </div>
        <UFormField label="Input Device">
          <USelect v-if="inputs.length" v-model="inputId" :items="inputs" class="w-full" />
          <UButton v-else :loading="micBusy" color="neutral" variant="outline" label="Grant microphone access" @click="loadDevices" />
        </UFormField>
        <UFormField v-if="outputs.length" label="Output Device">
          <USelect v-model="outputId" :items="outputs" class="w-full" />
        </UFormField>
      </div>
    </template>

    <template v-else>
      <h1 class="text-xl font-semibold text-highlighted">Chat</h1>
      <p class="mt-1 text-sm text-muted">How messages behave when you write them.</p>
      <div class="mt-8 divide-y divide-default">
        <div class="py-4">
          <p class="font-medium text-highlighted">Send Message</p>
          <p class="text-sm text-muted mt-1">Enter to send. Shift+Enter for a new line. Arrow up edits your last message.</p>
        </div>
        <div class="py-4">
          <p class="font-medium text-highlighted">Markdown</p>
          <p class="text-sm text-muted mt-1">Messages support a small markdown subset: bold, italic, code, links, and lists.</p>
        </div>
      </div>
    </template>

    <UModal v-model:open="confirmLogout" title="Log out?" description="You will need to sign in again on this device.">
      <template #footer>
        <UButton label="Cancel" color="neutral" variant="ghost" @click="confirmLogout = false" />
        <UButton label="Log Out" color="error" @click="logout" />
      </template>
    </UModal>
  </SettingsOverlay>
</template>

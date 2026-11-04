<script setup lang="ts">
import { USERNAME_HELP, accountEmailSchema, usernameSchema } from '~~/shared/account'
import type { AccountEmailStatus, SessionUser } from '~~/shared/types'

const props = defineProps<{ open: boolean }>()

const session = useSessionStore()
const { api } = useApi()
const toast = useToast()

const username = ref('')
const savingUsername = ref(false)
const usernameError = computed(() => {
  if (!username.value || username.value.trim() === session.user?.displayUsername) return ''
  return usernameSchema.safeParse(username.value).success ? '' : USERNAME_HELP
})
const usernameChanged = computed(() => Boolean(username.value.trim()) && username.value.trim() !== session.user?.displayUsername)

const status = ref<AccountEmailStatus | null>(null)
const newEmail = ref('')
const savingEmail = ref(false)
const emailValid = computed(() => accountEmailSchema.safeParse(newEmail.value).success)

async function load() {
  username.value = session.user?.displayUsername ?? ''
  newEmail.value = ''
  try { status.value = await api<AccountEmailStatus>('/api/me/email') }
  catch { status.value = null }
}

watch(() => props.open, (open) => { if (open) void load() }, { immediate: true })

async function saveUsername() {
  savingUsername.value = true
  try {
    const res = await api<{ user: SessionUser }>('/api/me', { method: 'PATCH', body: { username: username.value.trim() } })
    if (session.user) {
      session.user.username = res.user.username
      session.user.displayUsername = res.user.displayUsername
    }
    username.value = res.user.displayUsername ?? ''
    toast.add({ title: 'Username updated', color: 'success' })
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    savingUsername.value = false
  }
}

async function saveEmail(address = newEmail.value) {
  savingEmail.value = true
  try {
    const res = await api<{ confirmationSent: boolean }>('/api/me/email', { method: 'POST', body: { email: address } })
    toast.add({ title: res.confirmationSent ? 'Check your email to confirm it' : 'Email saved', color: 'success' })
    await load()
  }
  catch (err) {
    toast.add({ title: errorMessage(err), color: 'error' })
  }
  finally {
    savingEmail.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <form v-if="session.user?.username" class="space-y-2" @submit.prevent="saveUsername">
      <h2 class="text-sm font-semibold">Username</h2>
      <p class="text-sm text-muted">You sign in with this.</p>
      <UFormField :error="usernameError || undefined">
        <UInput v-model="username" name="username" autocomplete="username" autocapitalize="none" aria-label="Username" class="w-full" />
      </UFormField>
      <UButton type="submit" label="Change username" color="neutral" variant="outline" :loading="savingUsername" :disabled="!usernameChanged || Boolean(usernameError)" />
    </form>

    <div v-if="status && !status.managedByAccess" class="space-y-3">
      <h2 class="text-sm font-semibold">Email</h2>
      <p v-if="status.email && status.emailVerified" class="text-sm text-muted">
        <span class="text-highlighted">{{ status.email }}</span> is verified. You can sign in and reset your password with it.
      </p>
      <p v-else-if="status.email" class="text-sm text-muted">
        <span class="text-highlighted">{{ status.email }}</span> came from your sign-in provider and isn't verified here, so it can't be used to sign in.
      </p>
      <p v-else class="text-sm text-muted">Optional. A verified email lets you sign in with it and reset your password yourself.</p>

      <UAlert
        v-if="status.pendingEmail && status.mailReady"
        color="neutral"
        variant="subtle"
        :title="`Confirm ${status.pendingEmail}`"
        description="Open the link we sent. Until then it doesn't count for sign-in or password reset."
      >
        <template #actions>
          <UButton size="xs" color="neutral" variant="soft" label="Send again" :loading="savingEmail" @click="saveEmail(status!.pendingEmail!)" />
        </template>
      </UAlert>
      <UAlert
        v-else-if="status.pendingEmail"
        color="warning"
        variant="subtle"
        :title="`${status.pendingEmail} can't be confirmed yet`"
        description="This Server can't send mail right now. Your email is saved, but it doesn't count for sign-in or password reset until it's confirmed. Come back here once mail is set up."
      />
      <UAlert
        v-else-if="!status.mailReady"
        color="warning"
        variant="subtle"
        title="This Server can't send mail yet"
        description="You can save an email now, but it can't be confirmed until mail is set up."
      />

      <form class="space-y-2" @submit.prevent="saveEmail()">
        <UFormField :label="status.email || status.pendingEmail ? 'New email' : 'Add email'">
          <UInput v-model="newEmail" type="email" name="email" autocomplete="email" class="w-full" />
        </UFormField>
        <UButton type="submit" label="Save email" color="neutral" variant="outline" :loading="savingEmail" :disabled="!emailValid" />
      </form>
    </div>
  </div>
</template>

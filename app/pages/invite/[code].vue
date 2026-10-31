<script setup lang="ts">
import type { InvitePreviewDTO } from '~~/shared/types'
import { channelPath } from '~~/shared/paths'

definePageMeta({ layout: 'auth' })

const route = useRoute()
const session = useSessionStore()
const toast = useToast()
const code = computed(() => String(route.params.code))
const invite = ref<InvitePreviewDTO | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref(false)

onMounted(async () => {
  await session.refresh()
  try {
    const res = await plainFetch<{ invite: InvitePreviewDTO }>(`/api/invites/${code.value}`)
    invite.value = res.invite
    // Back from creating an account or signing in that started here: join without a second click.
    // Only this tab's own trip counts, so a link with ?join=1 alone never joins anyone.
    if (route.query.join === '1' && session.user && takeJoinIntent()) await accept()
  }
  catch (err) {
    error.value = errorMessage(err)
    toast.add({ title: error.value, color: 'error' })
  }
  finally {
    loading.value = false
  }
})

const joinIntentKey = 'llll.invite-join'
function rememberJoinIntent() {
  try { sessionStorage.setItem(joinIntentKey, code.value) } catch { /* The person then presses Join once more. */ }
}
function takeJoinIntent() {
  try {
    const intended = sessionStorage.getItem(joinIntentKey) === code.value
    sessionStorage.removeItem(joinIntentKey)
    return intended
  } catch { return false }
}

async function accept() {
  if (!session.user) {
    rememberJoinIntent()
    await navigateTo({ path: '/signup', query: { invite: code.value } })
    return
  }
  if (session.user.onboardingRequired) {
    await navigateTo({ path: '/signup/accept', query: { next: route.fullPath } })
    return
  }
  busy.value = true
  try {
    const res = await plainFetch<{ serverId: string; channelId: string | null }>(`/api/invites/${code.value}/accept`, { method: 'POST' })
    await navigateTo(res.channelId ? channelPath(res.channelId) : '/channels')
  }
  catch (err) {
    error.value = errorMessage(err)
    toast.add({ title: error.value, color: 'error' })
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Join server</h1>
    <USkeleton v-if="loading" class="mt-4 h-12 w-full" />
    <template v-else>
      <p v-if="invite" class="mt-1.5 text-sm text-muted">
        Invite to <span class="text-default font-medium">{{ invite.serverName }}</span>.
      </p>
      <UAlert v-else-if="error" color="error" variant="subtle" :title="error" class="mt-6" />
      <UButton
        class="mt-8"
        size="lg"
        block
        :label="session.user ? 'Join' : 'Create account to join'"
        :disabled="!invite"
        :loading="busy"
        @click="accept"
      />
      <p v-if="invite && !session.user" class="mt-4 text-center text-sm text-muted">
        Already have an account here?
        <ULink :to="{ path: '/login', query: { next: `/invite/${code}?join=1` } }" class="text-default font-medium" @click="rememberJoinIntent">Sign in</ULink>
      </p>
    </template>
  </div>
</template>

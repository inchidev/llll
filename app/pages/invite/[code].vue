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
    const res = await $fetch<{ invite: InvitePreviewDTO }>(`/api/invites/${code.value}`)
    invite.value = res.invite
  }
  catch (err) {
    error.value = errorMessage(err)
    toast.add({ title: error.value, color: 'error' })
  }
  finally {
    loading.value = false
  }
})

async function accept() {
  if (!session.user) {
    await navigateTo({ path: '/login', query: { next: route.fullPath } })
    return
  }
  if (session.user.onboardingRequired) {
    await navigateTo({ path: '/signup/accept', query: { next: route.fullPath } })
    return
  }
  busy.value = true
  try {
    const res = await $fetch<{ workspaceId: string; channelId: string | null }>(`/api/invites/${code.value}/accept`, { method: 'POST' })
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
    <h1 class="text-2xl font-semibold tracking-tight text-highlighted">Join workspace</h1>
    <USkeleton v-if="loading" class="mt-4 h-12 w-full" />
    <template v-else>
      <p v-if="invite" class="mt-1.5 text-sm text-muted">
        Invite to <span class="text-default font-medium">{{ invite.workspaceName }}</span>.
      </p>
      <UAlert v-else-if="error" color="error" variant="subtle" :title="error" class="mt-6" />
      <UButton
        class="mt-8"
        size="lg"
        block
        :label="session.user ? 'Join' : 'Sign in to join'"
        :disabled="!invite"
        :loading="busy"
        @click="accept"
      />
    </template>
  </div>
</template>

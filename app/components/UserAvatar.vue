<script setup lang="ts">
import type { PublicUser } from '~~/shared/types'

const props = defineProps<{
  user: Pick<PublicUser, 'id' | 'kind' | 'displayName' | 'avatarR2Key'>
}>()
const { serverUrl } = useApi()
const avatarSrc = computed(() => {
  const src = userAvatarSrc(props.user)
  return src?.startsWith('/api/') ? serverUrl(src) : src
})
</script>

<template>
  <!-- Agents are L4 blocks, people stay round, so the two read apart at a glance. -->
  <UAvatar
    :ui="props.user.kind === 'agent' ? { root: 'rounded-[28%]', image: 'rounded-[28%]' } : undefined"
    :src="avatarSrc"
    :text="(props.user.displayName || '?').slice(0, 1).toUpperCase()"
    :alt="props.user.displayName"
  />
</template>

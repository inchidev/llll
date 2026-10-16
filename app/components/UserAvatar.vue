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
  <UAvatar
    :src="avatarSrc"
    :text="(props.user.displayName || '?').slice(0, 1).toUpperCase()"
    :alt="props.user.displayName"
  />
</template>

<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'manage-server-settings'] })

const route = useRoute()
const { serverId } = useServer()
const open = ref(true)

/** `/server/:id/settings?section=roles` deep-links straight to a pane. */
const section = computed({
  get: () => String(route.query.section || 'overview'),
  set: value => void navigateTo({ query: { section: value } }, { replace: true }),
})

watch(open, (value) => {
  if (!value) void navigateTo('/channels')
})
</script>

<template>
  <SettingsServerSettings v-model:open="open" v-model:section="section" :server-id="serverId" />
</template>

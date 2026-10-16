<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'manage-workspace-settings'] })

const route = useRoute()
const { workspaceId } = useWorkspace()
const open = ref(true)

/** `/w/:id/settings?section=roles` deep-links straight to a pane. */
const section = computed({
  get: () => String(route.query.section || 'overview'),
  set: value => void navigateTo({ query: { section: value } }, { replace: true }),
})

watch(open, (value) => {
  if (!value) void navigateTo('/channels')
})
</script>

<template>
  <SettingsWorkspaceSettings v-model:open="open" v-model:section="section" :workspace-id="workspaceId" />
</template>

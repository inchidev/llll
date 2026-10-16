<script setup lang="ts">
definePageMeta({ middleware: ['auth'] })

const route = useRoute()
const open = ref(true)

/** `/settings?section=appearance` deep-links straight to a pane. */
const section = computed({
  get: () => String(route.query.section || 'account'),
  set: value => void navigateTo({ query: { section: value } }, { replace: true }),
})

watch(open, (value) => {
  if (!value) void navigateTo('/')
})
</script>

<template>
  <LayoutAppShell>
    <SettingsUserSettings v-model:open="open" v-model:section="section" />
  </LayoutAppShell>
</template>

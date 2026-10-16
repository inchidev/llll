<script setup lang="ts">
const session = useSessionStore()
const { workspaceId } = useWorkspace()
</script>

<template>
  <LayoutAppShell :workspace-id="workspaceId || undefined">
    <UAlert v-if="session.health?.bindings.r2 === false" class="m-3 shrink-0" color="warning" title="Files and backups are disabled" description="This workspace is running without R2. The owner can enable R2 from its L4 Admin, then reload the workspace." />
    <slot />
    <DataCreateDialogs />
  </LayoutAppShell>
</template>

<script setup lang="ts">
const session = useSessionStore()
const { serverId } = useServer()
provideDocumentCreateGuard()
</script>

<template>
  <LayoutAppShell :server-id="serverId || undefined">
    <UAlert v-if="(session.health?.bindings?.r2 === false && !session.health?.bindings?.kv)" class="m-3 shrink-0" color="warning" title="Files and backups are disabled" description="This server is running without R2. Ask the server operator to configure file storage for this server, then reload." />
    <slot />
    <DataCreateDialogs />
  </LayoutAppShell>
</template>

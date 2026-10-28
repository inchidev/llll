<script setup lang="ts">
import ServerAvatar from '../../../../packages/client-ui/ServerAvatar.vue'
const shell = useShell()
function forget(origin: string) {
  shell.error.value = ''
  try { shell.forget(origin) }
  catch (cause) { shell.error.value = cause instanceof Error ? cause.message : 'Could not remove this Server' }
}
</script>

<template>
  <div class="flex min-h-full flex-col">
    <header class="flex shrink-0 items-center justify-between gap-3 border-b border-default px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-8">
      <h1 class="flex h-11 items-center text-xl font-semibold tracking-tight">My Servers</h1>
      <UButton v-if="shell.servers.value.length" to="/create" label="Add a Server" icon="i-ph-plus" color="neutral" variant="outline" />
    </header>
    <div v-if="shell.servers.value.length" class="mx-auto w-full max-w-2xl px-4 py-6 sm:px-8 sm:py-8">
      <p class="text-sm leading-6 text-muted">Saved on this device. You sign in on each Server separately.</p>
      <UAlert v-if="shell.error.value" class="mt-4" color="error" :description="shell.error.value" />
      <ul aria-label="Saved Servers" class="mt-6 divide-y divide-default">
        <li v-for="server in shell.servers.value" :key="server.origin" class="flex min-w-0 items-center gap-2 py-2">
          <NuxtLink :to="`/${server.id}`" class="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-3 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary">
            <ServerAvatar :name="server.name" :icon-url="server.iconUrl" class="size-11 rounded-xl bg-accented" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{{ server.name }}</span>
              <span class="block truncate text-sm text-muted">{{ server.origin.replace(/^https?:\/\//, '') }}</span>
            </span>
            <span v-if="server.unread" :aria-label="`${server.unread} unread`" class="shrink-0 rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-inverted">{{ server.unread }}</span>
          </NuxtLink>
          <UButton :aria-label="`Remove ${server.name} from this device`" icon="i-ph-x" color="neutral" variant="ghost" @click="forget(server.origin)" />
        </li>
      </ul>
    </div>
    <div v-else class="flex flex-1 items-center justify-center px-4 py-12 sm:px-8">
      <div class="w-full max-w-md text-center">
        <UIcon name="i-ph-squares-four" class="mx-auto size-10 text-dimmed" />
        <h2 class="mt-5 text-xl font-semibold tracking-tight text-highlighted">Your Servers will appear here</h2>
        <p class="mt-3 text-sm leading-6 text-muted">A Server is your team’s own L4: its people, agents, projects and history. This device remembers the Servers you open, and you sign in on each one.</p>
        <UAlert v-if="shell.error.value" class="mt-4 text-start" color="error" :description="shell.error.value" />
        <div class="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <UButton to="/create" label="Connect a Server" icon="i-ph-link" />
          <UButton to="/create?tab=cloudflare" label="Create a new Server" icon="i-ph-plus" color="neutral" variant="outline" />
        </div>
      </div>
    </div>
  </div>
</template>

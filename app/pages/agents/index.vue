<script setup lang="ts">
import { Permission } from '~~/shared/permissions'
definePageMeta({ layout: 'server', middleware: ['auth', 'agents'] })
const { serverId } = useServer()
const { can } = useRoleGrants()
const nav = useNavActions()
const { agents, members, messageAgent, opening } = useAgentDirectory(() => serverId.value || '')
const search = ref('')
const visible = computed(() => agents.value.filter(agent => agent.user.displayName.toLowerCase().includes(search.value.toLowerCase())))
const { serverUrl } = useApi()
// Large figures use the same picture as avatars elsewhere; agent settings live in Settings → Agents.
function figure(user: Parameters<typeof userAvatarSrc>[0]) {
  const src = userAvatarSrc(user)
  return src?.startsWith('/api/') ? serverUrl(src) : src
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <LayoutPageHeader title="Agents" icon="i-ph-robot"><template #actions><UButton to="/runs" label="Runs" icon="i-ph-list-bullets" color="neutral" variant="ghost" /><UButton v-if="can(Permission.manageAgents)" label="Create agent" icon="i-ph-plus" @click="nav.createAgentOpen.value = true" /></template></LayoutPageHeader>
    <main class="min-h-0 flex-1 overflow-y-auto p-5 sm:p-8">
      <div class="mx-auto max-w-4xl">
        <h2 class="text-xl font-semibold text-highlighted">Work with an agent</h2><p class="mt-1 text-sm text-muted">Start a private conversation with an agent in this Server.</p>
        <UInput v-model="search" type="search" icon="i-ph-magnifying-glass" placeholder="Find an agent" aria-label="Find an agent" autocomplete="off" class="mt-5 w-full" />
        <LayoutSkeleton v-if="members.isPending.value" variant="nav" :rows="3" class="mt-6" />
        <LayoutLoadError v-else-if="members.error.value" message="Agents did not load." :retry="members.refetch" />
        <LayoutEmptyState v-else-if="!visible.length" icon="i-ph-robot" :title="agents.length ? 'No matching agents' : 'No agents yet'" :description="agents.length ? 'Try a different name.' : can(Permission.manageAgents) ? 'Create an agent to start working together.' : 'Ask a server administrator to add an agent.'">
          <UButton v-if="!agents.length && can(Permission.manageAgents)" label="Create agent" icon="i-ph-plus" @click="nav.createAgentOpen.value = true" />
        </LayoutEmptyState>
        <!-- Agents stand here waiting for you, Berd-style: one large figure each; a click opens the conversation. -->
        <ul v-else class="mt-8 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
          <li v-for="agent in visible" :key="agent.user.id">
            <button
              type="button"
              class="group flex w-full flex-col items-center gap-3 rounded-2xl p-3 text-center transition-colors hover:bg-elevated/60 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!can(Permission.useAgents) || Boolean(opening) || agent.agentStatus === 'paused'"
              :title="agent.agentStatus === 'paused' ? 'This agent is paused. Ask a server administrator to resume it.' : undefined"
              :aria-label="`Message ${agent.user.displayName}`"
              @click="messageAgent(agent.user.id)"
            >
              <span class="relative block aspect-square w-full max-w-40 transition-transform duration-200 group-hover:-translate-y-1 group-active:translate-y-0">
                <img v-if="figure(agent.user)" :src="figure(agent.user)" :alt="agent.user.displayName" class="size-full rounded-[28%] object-cover">
                <span v-if="opening === agent.user.id" class="absolute inset-0 flex items-center justify-center rounded-[28%] bg-black/40"><UIcon name="i-ph-spinner-gap" class="size-8 animate-spin text-white" /></span>
              </span>
              <span class="min-w-0 max-w-full">
                <span class="block truncate font-semibold text-highlighted">{{ agent.user.displayName }}</span>
                <span class="block truncate text-xs text-muted">{{ agent.agentStatus === 'paused' ? 'Paused' : agent.role.name }}</span>
              </span>
            </button>
          </li>
        </ul>
      </div>
    </main>
  </div>
</template>

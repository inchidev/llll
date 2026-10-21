<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { Permission } from '~~/shared/permissions'
import type { AgentDTO } from '~~/shared/types'
definePageMeta({ layout: 'server', middleware: ['auth', 'agents'] })
const { serverId } = useServer()
const { api } = useApi()
const { can } = useRoleGrants()
const nav = useNavActions()
const route = useRoute()
const { agents, members, messageAgent, opening } = useAgentDirectory(() => serverId.value || '')
const search = ref('')
const visible = computed(() => agents.value.filter(agent => (!route.query.agent || agent.user.id === route.query.agent) && agent.user.displayName.toLowerCase().includes(search.value.toLowerCase())))
const profiles = useQuery({ queryKey: computed(() => ['agents', serverId.value]), queryFn: () => api<{ agents: AgentDTO[] }>(`/api/servers/${serverId.value}/agents`), enabled: computed(() => can(Permission.manageAgents)) })
const editing = shallowRef<AgentDTO | null>(null)
const editorOpen = ref(false)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <LayoutPageHeader title="Agents" icon="i-ph-robot"><template #actions><UButton v-if="can(Permission.manageAgents)" label="Create agent" icon="i-ph-plus" @click="nav.createAgentOpen.value = true" /></template></LayoutPageHeader>
    <main class="min-h-0 flex-1 overflow-y-auto p-5 sm:p-8">
      <div class="mx-auto max-w-3xl">
        <h2 class="text-xl font-semibold text-highlighted">Work with an agent</h2><p class="mt-1 text-sm text-muted">Start a private conversation with an agent in this Server.</p>
        <UInput v-model="search" type="search" icon="i-ph-magnifying-glass" placeholder="Find an agent" aria-label="Find an agent" autocomplete="off" class="mt-5 w-full" />
        <LayoutSkeleton v-if="members.isPending.value" variant="nav" :rows="3" class="mt-6" />
        <LayoutLoadError v-else-if="members.error.value" message="Agents did not load." :retry="members.refetch" />
        <LayoutEmptyState v-else-if="!visible.length" icon="i-ph-robot" :title="agents.length ? 'No matching agents' : 'No agents yet'" description="Agents shared with this Server will appear here." />
        <ul v-else class="mt-6 divide-y divide-default">
          <li v-for="agent in visible" :key="agent.user.id" class="flex flex-wrap items-center gap-3 py-5">
            <UserAvatar :user="agent.user" size="lg" />
            <div class="min-w-0 flex-1"><h3 class="truncate font-semibold text-highlighted">{{ agent.user.displayName }}</h3><p class="text-sm text-muted">{{ agent.role.name }} · Agent</p></div>
            <UButton v-if="can(Permission.manageAgents) && profiles.data.value?.agents.some(item => item.id === agent.user.id)" icon="i-ph-pencil-simple" color="neutral" variant="ghost" :aria-label="`Edit ${agent.user.displayName}`" @click="editing = profiles.data.value?.agents.find(item => item.id === agent.user.id) || null; editorOpen = true" />
            <UButton v-if="can(Permission.useAgents)" icon="i-ph-chat-circle" label="Message" :loading="opening === agent.user.id" :disabled="Boolean(opening)" :aria-label="`Message ${agent.user.displayName}`" @click="messageAgent(agent.user.id)" />
          </li>
        </ul>
      </div>
    </main>
    <SettingsAgentEditorModal v-if="can(Permission.manageAgents)" v-model:open="editorOpen" :server-id="serverId || ''" :agent="editing" @saved="editing = $event" />
  </div>
</template>

<script setup lang="ts">
import type { AgentTurnDTO, ClientMsg, MemberDTO } from '~~/shared/types'

const props = defineProps<{
  channelId: string
  members: MemberDTO[]
  send: (msg: ClientMsg) => void
  canApprove?: boolean
}>()

const presence = usePresenceStore()
const runs = computed(() => presence.agentTurnsIn(props.channelId))
const grouped = computed(() => {
  const result = new Map<string, AgentTurnDTO[]>()
  for (const run of runs.value) {
    const agentRuns = result.get(run.agentId) ?? []
    agentRuns.push(run)
    result.set(run.agentId, agentRuns)
  }
  return [...result.entries()]
})

function nameOf(agentId: string) {
  return props.members.find(member => member.user.id === agentId)?.nickname
    || props.members.find(member => member.user.id === agentId)?.user.displayName
    || 'Agent'
}

function current(items: AgentTurnDTO[]) {
  return items.find(item => item.status !== 'queued') ?? items[0]
}

function queueCount(items: AgentTurnDTO[]) {
  return items.filter(item => item.status === 'queued').length
}

function commandOf(run: AgentTurnDTO) {
  const input = run.approval?.input
  if (input && typeof input === 'object' && 'command' in input && typeof input.command === 'string') return input.command
  return input ? JSON.stringify(input, null, 2) : ''
}

function control(agentId: string, action: 'stop' | 'approve' | 'reject', executionId?: string) {
  props.send({ t: 'agent.control', agentId, action, executionId })
}
</script>

<template>
  <!-- Lives at the top of the composer, so starting or finishing never moves the messages. -->
  <div v-if="grouped.length" class="divide-y divide-default border-b border-default" aria-live="polite">
    <template v-for="[agentId, items] in grouped" :key="agentId">
      <div v-if="current(items)?.approval" class="flex items-start gap-0.5 px-2 py-2">
        <span class="flex h-6 w-9 shrink-0 items-center justify-center"><UIcon name="i-ph-shield-warning" class="size-5 text-warning" /></span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium text-highlighted">{{ nameOf(agentId) }}</span>
            <UBadge :label="current(items)!.approval!.risk || 'approval'" color="warning" variant="subtle" size="sm" />
          </div>
          <p class="mt-1 text-sm text-default">{{ current(items)!.approval!.summary }}</p>
          <pre v-if="commandOf(current(items)!)" class="mt-2 max-h-32 overflow-auto rounded-md bg-muted px-2.5 py-2 text-xs text-toned">{{ commandOf(current(items)!) }}</pre>
          <div class="mt-2 flex gap-2">
            <UButton size="xs" label="Approve" icon="i-ph-check" :disabled="!canApprove" @click="control(agentId, 'approve', current(items)!.approval!.executionId)" />
            <UButton size="xs" label="Reject" icon="i-ph-x" color="neutral" variant="outline" :disabled="!canApprove" @click="control(agentId, 'reject', current(items)!.approval!.executionId)" />
          </div>
        </div>
      </div>
      <div v-else class="flex min-h-9 items-center gap-0.5 px-2 text-xs text-muted">
        <span class="flex w-9 shrink-0 justify-center">
          <UIcon
            :name="current(items)?.status === 'tool' ? 'i-ph-terminal-window' : 'i-ph-circle-notch'"
            class="size-4"
            :class="current(items)?.status === 'tool' ? '' : 'animate-spin'"
          />
        </span>
        <span class="min-w-0 flex-1 truncate"><span class="font-medium text-toned">{{ nameOf(agentId) }}</span> · {{ current(items)?.detail || 'Thinking' }}</span>
        <UBadge v-if="queueCount(items)" :label="`+${queueCount(items)} queued`" color="neutral" variant="subtle" size="sm" />
        <UTooltip text="Stop Agent"><UButton size="xs" color="error" variant="ghost" square icon="i-ph-stop-fill" aria-label="Stop Agent" @click="control(agentId, 'stop')" /></UTooltip>
      </div>
    </template>
  </div>
</template>

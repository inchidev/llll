<script setup lang="ts">
import { formatMicrocents } from '~~/shared/l4-compute'
const { overview, busy, connect, disconnect } = useL4Compute()
const route = useRoute(), toast = useToast(), confirmOpen = ref(false)
// The connect step ends with the browser back here, and the address says how it went.
onMounted(() => {
  const outcome = route.query.l4
  if (outcome === 'linked') toast.add({ title: 'L4 Compute linked', color: 'success' })
  else if (outcome === 'failed') toast.add({ title: 'L4 Compute was not linked', description: typeof route.query.message === 'string' ? route.query.message : undefined, color: 'error' })
  if (outcome) void navigateTo({ query: { section: 'compute' } }, { replace: true })
})
const data = computed(() => overview.data.value)
const money = formatMicrocents
</script>
<template>
  <section class="space-y-3 rounded-lg border border-default p-4" data-l4-compute>
    <div class="flex flex-wrap items-baseline justify-between gap-2"><h2 class="font-medium">L4 Compute</h2><UButton label="Pricing" color="neutral" variant="link" :to="data?.pricingUrl ?? 'https://llll.gg/pricing'" external target="_blank" /></div>
    <LayoutLoadError v-if="overview.error.value" message="L4 Compute did not load." :retry="overview.refetch" />
    <template v-else-if="data">
      <p class="text-sm text-muted">A box for each Task, started and stopped by llll.gg and paid by the hour of agent work, billed by the minute, with no limit on how many Agents work at once. The box is a microVM of its own for one Task of this Server; the Agent sees an ordinary Node with a durable disk.</p>
      <template v-if="data.linked">
        <p class="text-sm" data-l4-linked>{{ data.hosted ? 'This Server runs on L4 Cloud and uses L4 Compute with its own identity.' : `Linked to llll.gg account ${data.account}` }}</p>
        <p v-if="data.status" class="text-sm" data-l4-status>Credit {{ money(data.status.creditMicrocents) }} · Spent this month {{ money(data.status.spentThisMonthMicrocents) }} · Monthly limit {{ data.status.spendLimitMicrocents === null ? 'none' : money(data.status.spendLimitMicrocents) }}<template v-if="data.status.mayStartBox === false"> · No new box can start until credit or the limit allows</template></p>
        <UAlert v-if="data.statusError" color="warning" variant="subtle" icon="i-ph-warning" :title="data.statusError" :description="data.status ? 'Showing the last answer. Boxes already running are not affected.' : 'Credit and the spend limit will show once llll.gg answers. Local work does not wait for it.'" />
        <p class="text-xs text-muted">{{ data.boxes.active }} boxes running now · {{ data.boxes.retained }} kept for their Tasks. A box goes when its Task is Done. Credit and the monthly spend limit are set on llll.gg; a Task that needs a box when either runs out says so and waits for you.</p>
        <div class="flex flex-wrap gap-2">
          <UButton label="Credit and spend limit on llll.gg" color="neutral" variant="outline" :to="data.accountUrl" external target="_blank" />
          <UButton v-if="!data.hosted" label="Disconnect" color="neutral" variant="outline" :loading="busy" @click="confirmOpen = true" />
        </div>
        <UModal v-model:open="confirmOpen" title="Disconnect L4 Compute" description="Every box of this Server on L4 Compute is stopped and released now, and the Server token is forgotten. Repositories placed on L4 Compute need a new placement before Agents can work on them again."><template #footer><div class="flex justify-end gap-2"><UButton label="Keep" color="neutral" variant="outline" @click="confirmOpen = false" /><UButton label="Disconnect" color="error" :loading="busy" @click="disconnect().then(() => { confirmOpen = false })" /></div></template></UModal>
      </template>
      <template v-else>
        <p class="text-sm">Not linked. Sign in with your llll.gg account to add it; no API key and no environment variable.</p>
        <UAlert v-if="!data.canConnect" color="neutral" variant="subtle" title="Configure this Server’s public origin first" description="The link returns the browser to this Server’s address, which must be set." />
        <UButton label="Add L4 Compute" :disabled="!data.canConnect" :loading="busy" data-l4-connect @click="connect" />
      </template>
    </template>
  </section>
</template>

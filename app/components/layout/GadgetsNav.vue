<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { GadgetListDTO } from '~~/shared/gadgets'
import { gadgetPath } from '~~/shared/paths'

const props = defineProps<{ workspaceId: string }>()
const route = useRoute()
const { api } = useApi()
const nav = useNavActions()

const gadgetsQ = useQuery({
  queryKey: computed(() => ['gadgets', props.workspaceId]),
  queryFn: () => api<GadgetListDTO>(`/api/workspaces/${props.workspaceId}/gadgets`),
  enabled: computed(() => Boolean(props.workspaceId)),
})
const gadgets = computed(() => gadgetsQ.data.value?.gadgets ?? [])
const activeId = computed(() => String(route.query.gadget || '') || gadgets.value[0]?.id || '')
</script>

<template>
  <LayoutNavSection
    label="Apps"
    collapse-key="gadgets:apps"
    :create-label="gadgetsQ.data.value?.canManage ? 'Create app' : undefined"
    @create="nav.createGadgetOpen.value = true"
  >
    <LayoutSkeleton v-if="gadgetsQ.isPending.value" variant="nav" :rows="3" />
    <LayoutLoadError v-else-if="gadgetsQ.error.value" inline message="Apps did not load." :retry="gadgetsQ.refetch" />
    <p v-else-if="!gadgets.length" class="px-2 py-2 text-sm text-muted">No apps yet.</p>
    <ul v-else>
      <li v-for="gadget in gadgets" :key="gadget.id">
        <LayoutNavRow :to="gadgetPath(gadget.id)" :active="gadget.id === activeId">
          <template #leading><UIcon name="i-ph-app-window" class="size-[18px] shrink-0 text-dimmed" /></template>
          {{ gadget.name }}
          <template #trailing>
            <span v-if="!gadget.publishedVersion" class="shrink-0 text-[10px] uppercase tracking-wide text-dimmed">Draft</span>
          </template>
        </LayoutNavRow>
      </li>
    </ul>
  </LayoutNavSection>
</template>

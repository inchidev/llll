<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { boardPath } from '~~/shared/paths'
import type { TaskBoardDTO } from '~~/shared/types'

const props = defineProps<{ serverId: string }>()
const nav = useNavActions()
const { api } = useApi()
const toast = useToast()
const cache = useQueryClient()
const name = ref(''), busy = ref(false)
watch(nav.createBoardOpen, (open) => { if (!open) name.value = '' })
async function create() {
  if (busy.value || !name.value.trim()) return
  busy.value = true
  try {
    const { board } = await api<{ board: TaskBoardDTO }>(`/api/servers/${props.serverId}/boards`, { method: 'POST', body: { name: name.value } })
    nav.createBoardOpen.value = false
    await cache.invalidateQueries({ queryKey: ['boards'] })
    toast.add({ title: 'Board created', color: 'success' })
    await navigateTo(boardPath(board.id))
  }
  catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
</script>

<template>
  <UModal v-model:open="nav.createBoardOpen.value" title="Create board">
    <template #body>
      <UFormField label="Name"><UInput v-model="name" autofocus class="w-full" @keyup.enter="create" /></UFormField>
    </template>
    <template #footer>
      <UButton color="neutral" variant="ghost" label="Cancel" @click="nav.createBoardOpen.value = false" />
      <UButton label="Save" :loading="busy" :disabled="!name.trim()" @click="create" />
    </template>
  </UModal>
</template>

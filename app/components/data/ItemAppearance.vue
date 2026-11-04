<script setup lang="ts">
import type { DataItem } from '~~/shared/data-items'
const props = defineProps<{ item: DataItem; writable: boolean; saveDraft: () => Promise<boolean> }>()
const emit = defineEmits<{ updated: [item: DataItem] }>()
const { api } = useApi()
const open = ref(false),
  busy = ref(false),
  error = ref(''),
  icon = ref(''),
  cover = ref('')
watch(open, (value) => {
  if (value) {
    icon.value = props.item.icon ?? ''
    cover.value = props.item.cover ?? ''
    error.value = ''
  }
})
async function save() {
  busy.value = true
  error.value = ''
  try {
    if (!(await props.saveDraft())) return
    await nextTick()
    const result = await api<{ item: DataItem }>(`/api/items/${props.item.id}`, {
      method: 'PATCH',
      body: { version: props.item.version, icon: icon.value.trim() || null, cover: cover.value.trim() || null },
    })
    emit('updated', result.item)
    open.value = false
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <img
    v-if="item.cover"
    :src="item.cover"
    alt=""
    referrerpolicy="no-referrer"
    class="mb-5 h-44 w-full rounded-lg object-cover"
  >
  <div class="mb-2 flex items-center gap-2">
    <span v-if="item.icon" class="text-4xl">{{ item.icon }}</span
    ><UButton
      v-if="writable"
      label="Icon & cover"
      icon="i-ph-image"
      size="xs"
      color="neutral"
      variant="ghost"
      @click="open = true"
    />
  </div>
  <UModal v-model:open="open" title="Icon and cover">
    <template #body
      ><div class="space-y-4">
        <UAlert v-if="error" color="error" :description="error" /><UFormField
          label="Icon"
          description="An emoji or short symbol"
          ><UInput v-model="icon" :maxlength="80" class="w-full" /></UFormField
        ><UFormField label="Cover image URL" description="Use an HTTPS image URL. Leave empty to remove."
          ><UInput v-model="cover" type="url" class="w-full"
        /></UFormField></div
    ></template>
    <template #footer
      ><UButton label="Cancel" variant="ghost" color="neutral" @click="open = false" /><UButton
        label="Save"
        :loading="busy"
        @click="save"
    /></template>
  </UModal>
</template>

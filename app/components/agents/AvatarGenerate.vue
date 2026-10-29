<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'

/** Draws an avatar with the Avatars AI function, shows it, and hands back a file to save. */
const props = defineProps<{ serverId: string; name: string }>()
const emit = defineEmits<{ use: [file: File] }>()
const { api } = useApi()
const toast = useToast()
const functions = useQuery({ queryKey: computed(() => ['ai-function-availability', props.serverId]), queryFn: () => api<{ functions: { id: string; available: boolean }[] }>(`/api/servers/${props.serverId}/ai-functions`) })
const available = computed(() => functions.data.value?.functions.some(fn => fn.id === 'avatar.generate' && fn.available) === true)
const open = ref(false), description = ref(''), busy = ref(false), image = ref('')
async function generate() {
  if (busy.value) return
  busy.value = true
  try { image.value = (await api<{ image: string }>(`/api/servers/${props.serverId}/avatars/generate`, { method: 'POST', body: { name: props.name || 'Agent', ...(description.value.trim() ? { description: description.value.trim() } : {}) } })).image }
  catch (error) { toast.add({ title: 'No avatar was drawn', description: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
async function use() {
  const blob = await (await fetch(image.value)).blob()
  emit('use', new File([blob], `avatar.${blob.type.split('/')[1] || 'png'}`, { type: blob.type }))
  open.value = false; image.value = ''
}
</script>

<template>
  <template v-if="available">
    <UButton v-if="!open" size="sm" color="neutral" variant="outline" icon="i-ph-sparkle" label="Generate" @click="open = true" />
    <div v-else class="w-full space-y-2 rounded-md border border-default p-3">
      <UInput v-model="description" placeholder="Optional: a red cactus wearing sunglasses" class="w-full" aria-label="Describe the avatar" @keydown.enter.prevent="generate" />
      <img v-if="image" :src="image" alt="Generated avatar preview" class="size-24 rounded-[28%] object-cover">
      <div class="flex flex-wrap gap-2">
        <UButton size="sm" :label="image ? 'Try again' : 'Generate'" icon="i-ph-sparkle" :loading="busy" @click="generate" />
        <UButton v-if="image" size="sm" color="neutral" label="Use this picture" :disabled="busy" @click="use" />
        <UButton size="sm" color="neutral" variant="ghost" label="Cancel" :disabled="busy" @click="open = false; image = ''" />
      </div>
    </div>
  </template>
</template>

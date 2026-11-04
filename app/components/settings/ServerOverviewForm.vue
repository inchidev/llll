<script setup lang="ts">
import * as z from 'zod'
import type { Form, FormSubmitEvent } from '@nuxt/ui'

const props = defineProps<{ name: string; saving: boolean; editable: boolean }>()
const emit = defineEmits<{ save: [name: string] }>()
const schema = z.object({ name: z.string().trim().min(1).max(80) })
type Schema = z.output<typeof schema>
const state = reactive({ name: props.name })
const form = ref<Form<Schema>>()
const dirty = computed(() => state.name !== props.name)
// Metadata refreshes (including icon uploads) must not erase an unsaved name.
watch(() => props.name, (name, previous) => {
  if (state.name === previous) state.name = name
})
function save(event: FormSubmitEvent<Schema>) {
  if (!dirty.value || !props.editable || props.saving) return
  state.name = event.data.name
  emit('save', event.data.name)
}
function reset() {
  state.name = props.name
  form.value?.clear()
}
</script>

<template>
  <UForm ref="form" :schema="schema" :state="state" :data-update-blocked="dirty" class="w-full min-w-0 max-w-md space-y-4" @submit="save">
    <UFormField name="name" label="Server name">
      <UInput v-model="state.name" class="w-full" :disabled="!editable || saving" />
    </UFormField>
    <LayoutSaveBar v-if="editable" :dirty="dirty" :saving="saving" :disabled="!schema.safeParse(state).success" @save="form?.submit()" @reset="reset" />
  </UForm>
</template>

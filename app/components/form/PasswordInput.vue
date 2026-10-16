<script setup lang="ts">
const model = defineModel<string | undefined>()
const props = withDefaults(defineProps<{
  disabled?: boolean
  visibilityLabel?: string
}>(), {
  disabled: false,
  visibilityLabel: 'password',
})

const visible = ref(false)
</script>

<template>
  <UInput
    v-model="model"
    :type="visible ? 'text' : 'password'"
    :disabled="props.disabled"
  >
    <template #trailing>
      <UButton
        type="button"
        :icon="visible ? 'i-ph-eye-slash' : 'i-ph-eye'"
        :aria-label="visible ? `Hide ${props.visibilityLabel}` : `Show ${props.visibilityLabel}`"
        color="neutral"
        variant="link"
        size="sm"
        :disabled="props.disabled"
        @click="visible = !visible"
      />
    </template>
  </UInput>
</template>

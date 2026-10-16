<script setup lang="ts">
import type { PublicOnboardingConfig, RichTextDocument } from '~~/shared/types'

const props = defineProps<{ onboarding: PublicOnboardingConfig }>()
const accepted = defineModel<boolean>({ default: false })
const selected = ref<{ title: string; content: RichTextDocument } | null>(null)

const agreementLabel = computed(() => {
  const agreements = [props.onboarding.terms && 'Terms of service', props.onboarding.rules && 'Workspace rules'].filter(Boolean)
  if (agreements.length && props.onboarding.privacy) return `I agree to the ${agreements.join(' and ')} and acknowledge the Privacy policy.`
  if (agreements.length) return `I agree to the ${agreements.join(' and ')}.`
  return 'I acknowledge the Privacy policy.'
})

function show(title: string, content: RichTextDocument | null) {
  if (content) selected.value = { title, content }
}
</script>

<template>
  <div v-if="onboarding.acceptanceRequired" class="space-y-2">
    <UCheckbox v-model="accepted" :label="agreementLabel" />
    <div class="flex flex-wrap gap-x-3 gap-y-1 ps-7">
      <UButton v-if="onboarding.terms" label="Read terms" color="neutral" variant="link" size="xs" class="p-0" @click="show('Terms of service', onboarding.terms)" />
      <UButton v-if="onboarding.privacy" label="Read privacy policy" color="neutral" variant="link" size="xs" class="p-0" @click="show('Privacy policy', onboarding.privacy)" />
      <UButton v-if="onboarding.rules" label="Read workspace rules" color="neutral" variant="link" size="xs" class="p-0" @click="show('Workspace rules', onboarding.rules)" />
    </div>

    <UModal :open="Boolean(selected)" :title="selected?.title" scrollable @update:open="(open: boolean) => { if (!open) selected = null }">
      <template #body>
        <OnboardingDocumentView v-if="selected" :content="selected.content" />
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
import type { EditorToolbarItem } from '@nuxt/ui'
import type { PublicOnboardingConfig, RichTextDocument } from '~~/shared/types'

type DocumentKind = 'terms' | 'privacy' | 'rules'

const props = defineProps<{ workspaceId: string }>()
const toast = useToast()
const loading = ref(true)
const saving = ref(false)
const selected = ref<DocumentKind>('terms')
const documents = reactive<Record<DocumentKind, RichTextDocument>>({
  terms: emptyDocument(),
  privacy: emptyDocument(),
  rules: emptyDocument(),
})
const published = ref<PublicOnboardingConfig | null>(null)

const tabs: Array<{ id: DocumentKind; label: string }> = [
  { id: 'terms', label: 'Terms' },
  { id: 'privacy', label: 'Privacy policy' },
  { id: 'rules', label: 'Workspace rules' },
]
const descriptions: Record<DocumentKind, string> = {
  terms: 'The agreement members accept when creating an account.',
  privacy: 'How this installation handles account, message, and file data.',
  rules: 'Behaviour expected from members inside this workspace.',
}
const placeholders: Record<DocumentKind, string> = {
  terms: 'Write the terms members must accept…',
  privacy: 'Explain what data is collected and how it is handled…',
  rules: 'Write the rules members must follow…',
}
const toolbarItems = [[
  { kind: 'mark', mark: 'bold', icon: 'i-ph-text-b', 'aria-label': 'Bold', tooltip: { text: 'Bold' } },
  { kind: 'mark', mark: 'italic', icon: 'i-ph-text-italic', 'aria-label': 'Italic', tooltip: { text: 'Italic' } },
  { kind: 'link', icon: 'i-ph-link', 'aria-label': 'Link', tooltip: { text: 'Link' } },
], [
  { kind: 'heading', level: 2, icon: 'i-ph-text-h-two', 'aria-label': 'Heading', tooltip: { text: 'Heading' } },
  { kind: 'bulletList', icon: 'i-ph-list-bullets', 'aria-label': 'Bullet list', tooltip: { text: 'Bullet list' } },
  { kind: 'orderedList', icon: 'i-ph-list-numbers', 'aria-label': 'Numbered list', tooltip: { text: 'Numbered list' } },
  { kind: 'blockquote', icon: 'i-ph-quotes', 'aria-label': 'Quote', tooltip: { text: 'Quote' } },
], [
  { kind: 'undo', icon: 'i-ph-arrow-counter-clockwise', 'aria-label': 'Undo', tooltip: { text: 'Undo' } },
  { kind: 'redo', icon: 'i-ph-arrow-clockwise', 'aria-label': 'Redo', tooltip: { text: 'Redo' } },
]] satisfies EditorToolbarItem[][]

const activeDocument = computed<RichTextDocument>({
  get: () => documents[selected.value],
  set: value => { documents[selected.value] = value },
})

function emptyDocument(): RichTextDocument {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

function copyDocument(value: RichTextDocument | null): RichTextDocument {
  return value ? structuredClone(value) : emptyDocument()
}

function apply(value: PublicOnboardingConfig) {
  published.value = value
  documents.terms = copyDocument(value.terms)
  documents.privacy = copyDocument(value.privacy)
  documents.rules = copyDocument(value.rules)
}

async function load() {
  loading.value = true
  try {
    const response = await $fetch<{ onboarding: PublicOnboardingConfig }>(`/api/workspaces/${props.workspaceId}/onboarding`)
    apply(response.onboarding)
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    loading.value = false
  }
}

async function publish() {
  saving.value = true
  try {
    const response = await $fetch<{ onboarding: PublicOnboardingConfig }>(`/api/workspaces/${props.workspaceId}/onboarding`, {
      method: 'PUT',
      body: documents,
    })
    apply(response.onboarding)
    toast.add({
      title: response.onboarding.acceptanceRequired ? `Onboarding version ${response.onboarding.version} published` : 'Signup agreement disabled',
      color: 'success',
    })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">Onboarding</h1>
        <p class="mt-1 text-sm text-muted">Publish documents shown to people joining this workspace.</p>
      </div>
      <UBadge
        v-if="published?.version"
        :label="`Version ${published.version}`"
        color="neutral"
        variant="subtle"
      />
    </div>

    <LayoutSkeleton v-if="loading" variant="form" class="mt-6" />
    <template v-else>
      <div class="mt-6 flex flex-wrap gap-2">
        <UButton
          v-for="tab in tabs"
          :key="tab.id"
          :label="tab.label"
          color="neutral"
          :variant="selected === tab.id ? 'soft' : 'ghost'"
          @click="selected = tab.id"
        />
      </div>

      <p class="mt-4 text-sm text-muted">{{ descriptions[selected] }}</p>
      <ClientOnly>
        <UEditor
          v-slot="{ editor }"
          v-model="activeDocument"
          :image="false"
          :mention="false"
          :placeholder="{ placeholder: placeholders[selected], mode: 'firstLine' }"
          :starter-kit="{ heading: { levels: [1, 2, 3] } }"
          class="mt-3 overflow-hidden rounded-lg border border-default bg-elevated"
          :ui="{
            content: 'min-h-72',
            base: 'min-h-72 px-5 py-4 sm:px-5',
          }"
        >
          <UEditorToolbar :editor="editor" :items="toolbarItems" class="border-b border-default px-2 py-1.5" />
        </UEditor>
        <template #fallback>
          <USkeleton class="mt-3 h-80 w-full" />
        </template>
      </ClientOnly>

      <UAlert
        class="mt-5"
        color="neutral"
        variant="subtle"
        title="Publishing creates a new agreement version"
        description="New accounts must accept the current version. Existing members are not interrupted. Clear all three documents to remove the signup checkbox."
      />
      <div class="mt-6 flex justify-end">
        <UButton label="Save and publish" :loading="saving" @click="publish" />
      </div>
    </template>
  </div>
</template>

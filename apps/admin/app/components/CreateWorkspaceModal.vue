<script setup lang="ts">
import type { AdminSession, ProgressState, Workspace } from '../composables/useAdmin'

type Result = { url: string, setupUrl?: string, version: string }

const props = defineProps<{ workspaces: Workspace[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [] }>()
const session = useState<AdminSession | null>('admin-session')

const STEPS = [
  { id: 'account', label: 'Check the Cloudflare account' },
  { id: 'installation', label: 'Reserve the workspace' },
  { id: 'storage', label: 'Create workspace storage' },
  { id: 'database', label: 'Apply database migrations' },
  { id: 'assets', label: 'Upload the app' },
  { id: 'access', label: 'Configure sign-in' },
  { id: 'worker', label: 'Deploy the Worker' },
  { id: 'domain', label: 'Enable the workers.dev address' },
  { id: 'schedule', label: 'Schedule maintenance' },
  { id: 'verify', label: 'Verify workspace health' },
] as const

const appName = ref('')
const workerName = ref('')
const edited = ref(false)
const filesEnabled = ref(false)
const forMyself = ref(true)
const otherOwnerEmail = ref('')
const ownerEmail = computed(() => forMyself.value ? session.value?.owner?.email || '' : otherOwnerEmail.value.trim())
const phase = ref<'form' | 'working' | 'done'>('form')
const steps = ref<Record<string, ProgressState>>({})
const error = ref('')
const result = ref<Result | null>(null)

function slug(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 63).replace(/-+$/u, '')
}

watch(open, (value) => {
  if (!value || phase.value === 'working') return
  phase.value = 'form'
  error.value = ''
  result.value = null
  steps.value = {}
  appName.value = ''
  workerName.value = ''
  edited.value = false
  filesEnabled.value = false
  forMyself.value = true
  otherOwnerEmail.value = ''
})

watch(appName, (value) => {
  if (!edited.value) workerName.value = slug(value)
})

const subdomain = computed(() => {
  for (const workspace of props.workspaces) {
    const match = /^[^.]+\.([^.]+)\.workers\.dev$/u.exec(new URL(workspace.origin).hostname)
    if (match) return match[1]
  }
  return ''
})

const nameError = computed(() => {
  const name = workerName.value
  if (!name) return ''
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(name)) return 'Use lowercase letters, numbers, and hyphens.'
  if (name === 'llll-admin') return 'That address belongs to the Admin.'
  if (props.workspaces.some(workspace => workspace.workerName === name)) return 'A workspace with this address already exists.'
  return ''
})

const canSubmit = computed(() => Boolean(appName.value.trim() && workerName.value && !nameError.value
  && ownerEmail.value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(ownerEmail.value)))

async function create() {
  if (!canSubmit.value) return
  phase.value = 'working'
  error.value = ''
  steps.value = {}
  try {
    result.value = await streamProgress<Result>('/api/workspaces', {
      appName: appName.value.trim(), workerName: workerName.value, filesEnabled: filesEnabled.value,
      forMyself: forMyself.value, ownerEmail: ownerEmail.value,
    }, (step, state) => {
      steps.value = { ...steps.value, [step]: state }
    })
    phase.value = 'done'
  }
  catch (cause) {
    error.value = failureMessage(cause, 'The workspace could not be created')
    phase.value = 'form'
  }
  finally {
    emit('created')
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="phase === 'done' ? 'Workspace ready' : 'New workspace'"
    :dismissible="phase !== 'working'"
    :close="phase !== 'working'"
  >
    <template #body>
      <form v-if="phase === 'form'" id="create-workspace" class="space-y-5" @submit.prevent="create">
        <UAlert v-if="error" color="error" title="Creation stopped" :description="error" />
        <UFormField label="Workspace name" required>
          <UInput v-model="appName" maxlength="80" placeholder="Acme" autofocus class="w-full" />
        </UFormField>
        <UFormField label="Address" :error="nameError || undefined" required>
          <UInput v-model="workerName" maxlength="63" placeholder="acme" class="w-full" @update:model-value="edited = true" />
          <template #help>
            <span class="break-all">https://<span class="text-highlighted">{{ workerName || 'acme' }}</span>.{{ subdomain || 'your-subdomain' }}.workers.dev</span>
            <span class="mt-1 block">Also the Worker name in Cloudflare. It can't be changed later.</span>
          </template>
        </UFormField>
        <UCheckbox v-model="forMyself" label="This workspace is for me" />
        <UFormField label="Workspace owner email" required :help="forMyself ? 'Using your Admin email. You will create the workspace owner in the next step.' : 'Share the private setup link with this person so they can create their workspace owner account. No email is sent automatically.'">
          <UInput v-if="forMyself" :model-value="ownerEmail" type="email" readonly class="w-full" />
          <UInput v-else v-model="otherOwnerEmail" type="email" maxlength="254" placeholder="owner@example.com" required class="w-full" />
        </UFormField>
        <USwitch v-model="filesEnabled" label="Enable files and backups with R2" />
        <UAlert v-if="!filesEnabled" color="warning" title="Start without R2" description="Chat, Tasks, Mail, and Data work without file storage. Attachments, uploaded avatars, and workspace backups are disabled. Enable R2 and connect it here later." />
        <p v-else class="text-sm text-muted">First enable an R2 subscription in Cloudflare. R2 includes free monthly usage; additional usage is billed by Cloudflare.</p>
        <p class="text-sm text-muted">The workspace starts invite-only on workers.dev. Connect domains, email, and Live from its Workspace Settings.</p>
      </form>
      <div v-else-if="phase === 'working'" class="space-y-5">
        <ProgressList :steps="STEPS" :state="steps" />
        <p class="text-xs text-dimmed">This usually takes one to three minutes. Keep this tab open.</p>
      </div>
      <div v-else-if="result" class="space-y-4">
        <p class="font-medium text-highlighted">{{ appName }} is running on L4 {{ result.version }}.</p>
        <ULink :to="result.url" target="_blank" class="block truncate text-sm text-primary">{{ result.url }}</ULink>
        <UAlert v-if="!filesEnabled" color="warning" title="Files and backups are disabled" description="You can enable R2 later from this workspace’s Admin page." />
        <p v-if="result.setupUrl" class="text-sm text-muted">Next, create the workspace owner. The private setup link works once; you can issue a new one from the workspace page.</p>
      </div>
    </template>
    <template v-if="phase !== 'working'" #footer>
      <template v-if="phase === 'form'">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton type="submit" form="create-workspace" label="Create workspace" :disabled="!canSubmit" />
      </template>
      <template v-else-if="result">
        <UButton label="Done" color="neutral" variant="ghost" @click="open = false" />
        <UButton :to="result.setupUrl || result.url" external target="_blank" :label="result.setupUrl ? 'Continue to owner setup' : 'Open workspace'" trailing-icon="i-ph-arrow-up-right" />
      </template>
    </template>
  </UModal>
</template>

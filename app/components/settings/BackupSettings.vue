<script setup lang="ts">
import type { Form, FormSubmitEvent } from '@nuxt/ui'
import * as z from 'zod'
import type { BackupDestinationDTO, BucketBackupResultDTO } from '~~/shared/backups'
import { formatBytes, formatDateTime } from '~~/shared/format'
const { api } = useApi()

const filesEnabled = computed(() => Boolean(useSessionStore().health?.bindings?.r2 || useSessionStore().health?.bindings?.kv))

const props = defineProps<{ serverId: string }>()
const toast = useToast()
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const uploading = ref(false)
const removeConfirm = ref(false)
const showSecret = ref(false)
const destination = shallowRef<BackupDestinationDTO | null>(null)

const schema = z.object({
  endpoint: z.string().trim().url('Enter a valid endpoint URL').max(1000)
    .refine(value => URL.canParse(value) && new URL(value).protocol === 'https:', 'Endpoint must use HTTPS')
    .refine((value) => {
      if (!URL.canParse(value)) return false
      const url = new URL(value)
      return !url.username && !url.password && !url.search && !url.hash
    }, 'Endpoint cannot contain credentials, a query, or a fragment'),
  region: z.string().trim().min(1, 'Required').max(100),
  bucket: z.string().trim().min(1, 'Required').max(255)
    .refine(value => !/[\s/\\]/u.test(value), 'Bucket cannot contain spaces or slashes')
    .refine(value => value !== '.' && value !== '..', 'Invalid bucket name'),
  prefix: z.string().trim().max(500)
    .refine(value => [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    }), 'Prefix cannot contain control characters')
    .refine(value => !value.split('/').some(segment => segment === '.' || segment === '..'), 'Prefix cannot contain . or .. path segments'),
  accessKeyId: z.string().trim().min(1, 'Required').max(1000),
  secretAccessKey: z.string().max(4000),
})
type Schema = z.output<typeof schema>
const form = useTemplateRef<Form<typeof schema>>('form')
const state = reactive<Schema>({
  endpoint: '',
  region: 'auto',
  bucket: '',
  prefix: 'llll',
  accessKeyId: '',
  secretAccessKey: '',
})

const destinationDirty = computed(() => {
  const saved = destination.value
  return !saved || state.endpoint !== (saved.endpoint ?? '') || state.region !== saved.region
    || state.bucket !== (saved.bucket ?? '') || state.prefix !== saved.prefix
    || state.accessKeyId !== (saved.accessKeyId ?? '') || Boolean(state.secretAccessKey)
})

const downloadUrl = computed(() => `/api/servers/${encodeURIComponent(props.serverId)}/backup`)
const destinationStatus = computed(() => {
  if (destination.value?.configured) return 'Configured'
  if (destination.value?.secretConfigured && !destination.value.secretReadable) return 'Replace secret'
  return 'Not configured'
})
const destinationStatusColor = computed(() => destination.value?.configured ? 'success' : 'neutral')

function apply(value: BackupDestinationDTO) {
  destination.value = value
  state.endpoint = value.endpoint ?? ''
  state.region = value.region
  state.bucket = value.bucket ?? ''
  state.prefix = value.prefix
  state.accessKeyId = value.accessKeyId ?? ''
  state.secretAccessKey = ''
  showSecret.value = false
}

async function load() {
  loading.value = true
  try {
    const response = await api<{ destination: BackupDestinationDTO }>(`/api/servers/${props.serverId}/backup-destination`)
    apply(response.destination)
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    loading.value = false
  }
}

async function save(event: FormSubmitEvent<Schema>) {
  saving.value = true
  try {
    const response = await api<{ destination: BackupDestinationDTO }>(`/api/servers/${props.serverId}/backup-destination`, {
      method: 'PATCH',
      body: event.data,
    })
    apply(response.destination)
    toast.add({ title: 'Backup destination saved', color: 'success' })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

async function validatedState() {
  try {
    return await form.value?.validate({ transform: true })
  }
  catch {
    return null
  }
}

async function testConnection() {
  const data = await validatedState()
  if (!data) return
  testing.value = true
  try {
    await api(`/api/servers/${props.serverId}/backup-destination/test`, {
      method: 'POST',
      body: data,
    })
    toast.add({ title: 'S3 connection works', description: 'A temporary object was uploaded and removed.', color: 'success' })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    testing.value = false
  }
}

async function backupToBucket() {
  if (destinationDirty.value || uploading.value || saving.value || testing.value) return
  uploading.value = true
  try {
    const result = await api<BucketBackupResultDTO>(`/api/servers/${props.serverId}/backup-to-bucket`, { method: 'POST' })
    await load()
    toast.add({
      title: 'Backup saved to bucket',
      description: `${result.key} · ${formatBytes(result.sizeBytes)}`,
      color: 'success',
    })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    uploading.value = false
  }
}

async function remove() {
  saving.value = true
  try {
    const response = await api<{ destination: BackupDestinationDTO }>(`/api/servers/${props.serverId}/backup-destination`, {
      method: 'PATCH',
      body: { remove: true },
    })
    apply(response.destination)
    removeConfirm.value = false
    toast.add({ title: 'Backup destination removed', color: 'success' })
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
    <h1 class="text-xl font-semibold text-highlighted">Backups</h1>
    <p class="mt-1 text-sm text-muted">Create a manual server archive.</p>

    <UAlert v-if="!filesEnabled" class="mt-5" color="warning" title="Backups are disabled" description="Ask the server operator to configure file storage for this server, then reload." />
    <div class="mt-8 rounded-lg border border-default bg-elevated p-5">
      <div class="flex items-start gap-3">
        <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accented text-muted">
          <UIcon name="i-ph-download-simple" class="size-5" />
        </div>
        <div class="min-w-0">
          <p class="font-medium text-highlighted">Download to this device</p>
          <p class="mt-1 text-sm leading-6 text-muted">
            Download a TAR containing a logical D1 export and every object currently stored in R2.
          </p>
        </div>
      </div>

      <UAlert
        class="mt-5"
        color="warning"
        variant="subtle"
        title="This can take a long time"
        description="The browser connection must remain open while the Worker reads the database and every stored file. Keep the server idle and do not close this tab until the download starts and finishes."
      />

      <form class="mt-5" method="post" :action="downloadUrl" target="_blank">
        <UButton type="submit" label="Download backup" :disabled="!filesEnabled" trailing-icon="i-ph-download-simple" />
      </form>
    </div>

    <div class="mt-5 rounded-lg border border-default bg-elevated p-5">
      <div class="flex items-start gap-3">
        <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accented text-muted">
          <UIcon name="i-ph-cloud-arrow-up" class="size-5" />
        </div>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <p class="font-medium text-highlighted">Save to S3-compatible bucket</p>
            <UBadge :label="destinationStatus" :color="destinationStatusColor" variant="subtle" />
          </div>
          <p class="mt-1 text-sm leading-6 text-muted">
            Use Cloudflare R2, AWS S3, Backblaze B2, Wasabi, MinIO, or another S3-compatible service.
          </p>
        </div>
      </div>

      <UAlert
        class="mt-5"
        color="warning"
        variant="subtle"
        title="Use a separate private bucket"
        description="Do not use the R2 bucket already bound to L4. Otherwise future archives can include previous backups, and one bucket failure can remove both the server files and their backups."
      />

      <LayoutSkeleton v-if="loading" variant="form" class="mt-5" />
      <template v-else-if="destination">
        <UAlert
          v-if="destination.secretConfigured && !destination.secretReadable"
          class="mt-5"
          color="error"
          variant="subtle"
          title="Saved Secret Access Key cannot be decrypted. Replace it."
        />

        <UAlert v-if="destination.source === 'binding'" class="mt-5" color="success" title="Separate backup bucket provided by this deployment" :description="destination.bucket || undefined" />
        <UForm v-else ref="form" :schema="schema" :state="state" class="mt-5 space-y-5" @submit="save">
          <UFormField
            name="endpoint"
            label="Endpoint"
            description="Service endpoint without the bucket name. HTTPS is required."
            required
          >
            <UInput v-model="state.endpoint" class="w-full" placeholder="https://account-id.r2.cloudflarestorage.com" autocomplete="url" />
          </UFormField>

          <div class="grid gap-5 sm:grid-cols-2">
            <UFormField name="region" label="Region" description="Use auto for Cloudflare R2." required>
              <UInput v-model="state.region" class="w-full" autocomplete="off" />
            </UFormField>
            <UFormField name="bucket" label="Bucket" required>
              <UInput v-model="state.bucket" class="w-full" autocomplete="off" />
            </UFormField>
          </div>

          <UFormField name="prefix" label="Prefix" hint="Optional" description="Backups are stored below this object-key prefix.">
            <UInput v-model="state.prefix" class="w-full" placeholder="llll" autocomplete="off" />
          </UFormField>

          <div class="grid gap-5 sm:grid-cols-2">
            <UFormField name="accessKeyId" label="Access Key ID" required>
              <UInput v-model="state.accessKeyId" class="w-full" autocomplete="off" />
            </UFormField>
            <UFormField name="secretAccessKey" label="Secret Access Key" :required="!destination.secretConfigured">
              <UInput
                v-model="state.secretAccessKey"
                class="w-full"
                :type="showSecret ? 'text' : 'password'"
                :placeholder="destination.secretConfigured ? 'Saved; enter to replace' : ''"
                autocomplete="new-password"
              >
                <template #trailing>
                  <UButton
                    v-if="state.secretAccessKey"
                    type="button"
                    :icon="showSecret ? 'i-ph-eye-slash' : 'i-ph-eye'"
                    :aria-label="showSecret ? 'Hide Secret Access Key' : 'Show Secret Access Key'"
                    color="neutral"
                    variant="link"
                    size="sm"
                    @click="showSecret = !showSecret"
                  />
                </template>
              </UInput>
            </UFormField>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3">
            <div v-if="destination.secretConfigured" class="flex items-center gap-2">
              <template v-if="removeConfirm">
                <UButton type="button" label="Cancel" color="neutral" variant="ghost" @click="removeConfirm = false" />
                <UButton type="button" label="Confirm removal" color="error" variant="soft" :loading="saving" @click="remove" />
              </template>
              <UButton v-else type="button" label="Remove destination" color="error" variant="ghost" @click="removeConfirm = true" />
            </div>
            <span v-else />
            <div class="flex items-center gap-2">
              <UButton
                type="button"
                label="Test connection"
                color="neutral"
                variant="outline"
                trailing-icon="i-ph-plugs-connected"
                :loading="testing"
                :disabled="saving || uploading"
                @click="testConnection"
              />
              <UButton type="submit" label="Save credentials" trailing-icon="i-ph-floppy-disk" :loading="saving" :disabled="testing || uploading" />
            </div>
          </div>
        </UForm>

        <div v-if="destination.configured" class="mt-6 border-t border-default pt-5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-highlighted">Manual bucket backup</p>
              <p v-if="destination.lastBackupAt" class="mt-1 text-sm text-muted">
                Last completed {{ formatDateTime(destination.lastBackupAt) }} · {{ formatBytes(destination.lastBackupSizeBytes ?? 0) }}
              </p>
              <p v-else class="mt-1 text-sm text-muted">No completed bucket backup yet.</p>
            </div>
            <UButton
              type="button"
              label="Backup to bucket"
              trailing-icon="i-ph-cloud-arrow-up"
              :loading="uploading"
              :disabled="!filesEnabled || saving || testing || destinationDirty"
              @click="backupToBucket"
            />
          </div>
          <p v-if="destinationDirty" class="mt-3 text-sm text-muted">Save credentials before starting a bucket backup.</p>
          <p v-if="uploading" class="mt-3 text-sm text-muted">
            Keep this tab open. Large servers can take several minutes to upload.
          </p>
        </div>
      </template>
    </div>

    <UAlert
      class="mt-5"
      color="neutral"
      variant="subtle"
      title="Archive scope"
      description="Backups contain messages, authentication records, and R2 files. Environment secrets, live Durable Object state, KV tickets, and external RealtimeKit data are not included. Preserve AUTH_SECRET separately."
    />
  </div>
</template>

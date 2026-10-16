<script setup lang="ts">
import type { AuthCredentialProvider, AuthSettingsAdminDTO, RegistrationMode } from '~~/shared/types'
const { api } = useApi()

const props = defineProps<{ workspaceId: string }>()
const toast = useToast()
const loading = ref(true)
const saving = ref(false)
const auth = ref<AuthSettingsAdminDTO | null>(null)
const registrationMode = ref<RegistrationMode>('invite_only')
const email = reactive({ enabled: true, sender: '', senderName: '' })
const providers = reactive<Record<AuthCredentialProvider, { enabled: boolean; publicKey: string; secret: string; removeCredential: boolean }>>({
  github: { enabled: false, publicKey: '', secret: '', removeCredential: false },
  google: { enabled: false, publicKey: '', secret: '', removeCredential: false },
  linkedin: { enabled: false, publicKey: '', secret: '', removeCredential: false },
  twitter: { enabled: false, publicKey: '', secret: '', removeCredential: false },
  telegram: { enabled: false, publicKey: '', secret: '', removeCredential: false },
  turnstile: { enabled: false, publicKey: '', secret: '', removeCredential: false },
})

const socialProviders = [
  { id: 'github' as const, label: 'GitHub', publicLabel: 'Client ID', secretLabel: 'Client secret', callback: '/api/auth/callback/github' },
  { id: 'google' as const, label: 'Google', publicLabel: 'Client ID', secretLabel: 'Client secret', callback: '/api/auth/callback/google' },
  { id: 'linkedin' as const, label: 'LinkedIn', publicLabel: 'Client ID', secretLabel: 'Client secret', callback: '/api/auth/callback/linkedin' },
  { id: 'twitter' as const, label: 'X', publicLabel: 'Client ID', secretLabel: 'Client secret', callback: '/api/auth/callback/twitter' },
  { id: 'telegram' as const, label: 'Telegram', publicLabel: 'Client ID', secretLabel: 'Client secret', callback: '/api/auth/callback/telegram' },
]

function apply(value: AuthSettingsAdminDTO) {
  auth.value = value
  registrationMode.value = value.registrationMode
  email.enabled = value.email.enabled
  email.sender = value.email.sender ?? ''
  email.senderName = value.email.senderName ?? ''
  for (const provider of [...socialProviders.map(item => item.id), 'turnstile' as const]) {
    providers[provider].enabled = value.providers[provider].enabled
    providers[provider].publicKey = value.providers[provider].publicKey ?? ''
    providers[provider].secret = ''
    providers[provider].removeCredential = false
  }
}

async function load() {
  loading.value = true
  try {
    const response = await api<{ auth: AuthSettingsAdminDTO }>(`/api/workspaces/${props.workspaceId}/auth`)
    apply(response.auth)
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const response = await api<{ auth: AuthSettingsAdminDTO }>(`/api/workspaces/${props.workspaceId}/auth`, {
      method: 'PATCH',
      body: {
        registrationMode: registrationMode.value,
        email: {
          enabled: email.enabled,
          sender: email.sender || null,
          senderName: email.senderName || null,
        },
        providers,
      },
    })
    apply(response.auth)
    toast.add({ title: 'Authentication updated', color: 'success' })
  }
  catch (error) {
    toast.add({ title: errorMessage(error), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

function removeCredential(provider: AuthCredentialProvider) {
  providers[provider].publicKey = ''
  providers[provider].secret = ''
  providers[provider].enabled = false
  providers[provider].removeCredential = true
}

function sourceLabel(provider: AuthCredentialProvider) {
  const source = auth.value?.providers[provider].source
  if (source === 'deployment') return 'Managed by deployment'
  if (source === 'database') return 'Configured'
  return 'Not configured'
}

onMounted(load)
</script>

<template>
  <div>
    <h1 class="text-xl font-semibold text-highlighted">Authentication</h1>
    <LayoutSkeleton v-if="loading" variant="form" class="mt-6" />
    <UAlert
      v-else-if="auth?.mode === 'access'"
      class="mt-6"
      color="neutral"
      variant="subtle"
      title="Managed by Cloudflare Access"
      description="Cloudflare sends the sign-in code and controls which email addresses may reach this workspace. Change the Access application policy in your Cloudflare account."
    />
    <template v-else-if="auth">
      <UFormField label="Registration" class="mt-6 max-w-sm">
        <USelect
          v-model="registrationMode"
          :items="[
            { label: 'Invite only', value: 'invite_only' },
            { label: 'Open signup', value: 'open' },
          ]"
          value-key="value"
          label-key="label"
          class="w-full"
        />
      </UFormField>

      <h2 class="mt-10 text-xs font-bold uppercase tracking-wide text-muted">Email</h2>
      <div class="mt-3 space-y-4 rounded-lg bg-elevated p-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="font-medium text-highlighted">Email and password</p>
            <p class="text-sm text-muted">New addresses must be verified.</p>
          </div>
          <USwitch v-model="email.enabled" aria-label="Enable email and password" />
        </div>
        <UAlert v-if="!auth.email.binding" color="warning" variant="subtle" title="Cloudflare Email binding is not connected" />
        <UAlert
          v-if="email.enabled && !auth.passwordResetEnabled"
          color="warning"
          variant="subtle"
          title="Password reset is unavailable"
          description="Connect the Email binding and configure a sender address to enable reset emails."
        />
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Sender address">
            <UInput v-model="email.sender" type="email" class="w-full" :disabled="auth.email.senderManagedByDeployment" placeholder="login@example.com" />
          </UFormField>
          <UFormField label="Sender name">
            <UInput v-model="email.senderName" class="w-full" :disabled="auth.email.senderManagedByDeployment" placeholder="L4" />
          </UFormField>
        </div>
        <UBadge v-if="auth.email.senderManagedByDeployment" label="Sender managed by deployment" color="neutral" variant="subtle" />
      </div>

      <h2 class="mt-10 text-xs font-bold uppercase tracking-wide text-muted">Login methods</h2>
      <div class="mt-3 divide-y divide-default rounded-lg bg-elevated px-4">
        <div v-for="provider in socialProviders" :key="provider.id" class="py-5">
          <div class="flex items-center justify-between gap-4">
            <div class="flex items-center gap-2">
              <p class="font-medium text-highlighted">{{ provider.label }}</p>
              <UBadge :label="sourceLabel(provider.id)" color="neutral" variant="subtle" />
            </div>
            <USwitch v-model="providers[provider.id].enabled" :aria-label="`Enable ${provider.label}`" />
          </div>
          <p class="mt-1 text-xs text-muted">Callback: {{ provider.callback }}</p>
          <div class="mt-4 grid gap-4 sm:grid-cols-2">
            <UFormField :label="provider.publicLabel">
              <UInput v-model="providers[provider.id].publicKey" class="w-full" :disabled="auth.providers[provider.id].source === 'deployment'" />
            </UFormField>
            <UFormField :label="provider.secretLabel">
              <FormPasswordInput
                v-model="providers[provider.id].secret"
                class="w-full"
                visibility-label="secret"
                :disabled="auth.providers[provider.id].source === 'deployment'"
                :placeholder="auth.providers[provider.id].configured ? 'Saved; enter to replace' : ''"
              />
            </UFormField>
          </div>
          <UButton
            v-if="auth.providers[provider.id].source === 'database'"
            class="mt-3"
            size="xs"
            color="error"
            variant="ghost"
            label="Remove credentials"
            @click="removeCredential(provider.id)"
          />
          <UAlert v-if="!auth.providers[provider.id].secretReadable" class="mt-3" color="error" variant="subtle" title="Saved secret cannot be decrypted. Replace it." />
        </div>
      </div>

      <h2 class="mt-10 text-xs font-bold uppercase tracking-wide text-muted">Signup protection</h2>
      <div class="mt-3 rounded-lg bg-elevated p-4">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-2">
            <p class="font-medium text-highlighted">Cloudflare Turnstile</p>
            <UBadge :label="sourceLabel('turnstile')" color="neutral" variant="subtle" />
          </div>
          <USwitch v-model="providers.turnstile.enabled" aria-label="Enable Turnstile" />
        </div>
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <UFormField label="Site key">
            <UInput v-model="providers.turnstile.publicKey" class="w-full" :disabled="auth.providers.turnstile.source === 'deployment'" />
          </UFormField>
          <UFormField label="Secret key">
            <FormPasswordInput
              v-model="providers.turnstile.secret"
              class="w-full"
              visibility-label="secret key"
              :disabled="auth.providers.turnstile.source === 'deployment'"
              :placeholder="auth.providers.turnstile.configured ? 'Saved; enter to replace' : ''"
            />
          </UFormField>
        </div>
        <UButton
          v-if="auth.providers.turnstile.source === 'database'"
          class="mt-3"
          size="xs"
          color="error"
          variant="ghost"
          label="Remove credentials"
          @click="removeCredential('turnstile')"
        />
      </div>

      <div class="mt-8 flex justify-end">
        <UButton label="Save changes" :loading="saving" @click="save" />
      </div>
    </template>
  </div>
</template>

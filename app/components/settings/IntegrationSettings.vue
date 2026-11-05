<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { IntegrationKey, IntegrationsDTO } from '~~/shared/integrations'
import type { SetupHealth } from '~~/shared/types'

const props = defineProps<{ serverId: string }>()
const { api } = useApi()
const toast = useToast()
const session = useSessionStore()
const root = computed(() => `/api/servers/${props.serverId}/integrations`)
const query = useQuery({ queryKey: computed(() => ['integrations', props.serverId]), queryFn: () => api<IntegrationsDTO>(root.value) })
const data = computed(() => query.data.value)

const draft = reactive<Partial<Record<IntegrationKey, string>>>({})
const busy = ref(''), error = ref('')
type Inbound = 'postmark' | 'mailgun' | 'ses' | 'bridge'
const inbound = ref<Inbound>('postmark')
/** A secret L4 made up, kept only so the full webhook address can be shown once. */
const postmarkAddress = ref('')

const inboundOptions = [{ label: 'Postmark', value: 'postmark' }, { label: 'Mailgun', value: 'mailgun' }, { label: 'Amazon SES', value: 'ses' }, { label: 'My own bridge', value: 'bridge' }]
const inboundKey: Record<Inbound, IntegrationKey> = { postmark: 'POSTMARK_INBOUND_SECRET', mailgun: 'MAILGUN_WEBHOOK_SIGNING_KEY', ses: 'SES_SNS_TOPIC_ARN', bridge: 'INBOUND_EMAIL_SECRET' }

const labels: Record<string, string> = {
  exa: 'Exa', openrouter: 'OpenRouter', workers: 'Cloudflare Browser Run', 'cloudflare-rest': 'Cloudflare', cdp: 'Your Chromium',
  binding: 'Cloudflare', gateway: 'HTTP gateway', smtp: 'SMTP gateway', bridge: 'Your bridge', postmark: 'Postmark', mailgun: 'Mailgun', ses: 'Amazon SES',
  realtimekit: 'Cloudflare RealtimeKit', 'realtimekit-rest': 'Cloudflare RealtimeKit',
}
const statusLabel = (value: string | null) => value ? `On: ${labels[value] ?? value}` : 'Off'
const field = (key: IntegrationKey) => data.value?.fields[key]
const managed = (key: IntegrationKey) => field(key)?.source === 'deployment'
const saved = (key: IntegrationKey) => field(key)?.source === 'settings'

function randomSecret() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function generate(key: IntegrationKey) {
  draft[key] = randomSecret()
}

async function save(id: string, keys: IntegrationKey[], values?: Partial<Record<IntegrationKey, string | null>>) {
  const body = values ?? Object.fromEntries(keys.filter(key => draft[key]?.trim()).map(key => [key, draft[key]!.trim()]))
  if (!Object.keys(body).length) return
  busy.value = id
  error.value = ''
  try {
    await api(root.value, { method: 'PUT', body: { values: body } })
    const postmark = body.POSTMARK_INBOUND_SECRET
    if (postmark && data.value) {
      const url = new URL(data.value.webhooks.postmark)
      url.username = 'postmark'
      url.password = postmark
      postmarkAddress.value = url.href
    }
    for (const key of keys) delete draft[key]
    await query.refetch()
    // Mail and Live screens read what this Server can do from the session.
    session.health = await api<SetupHealth>('/api/setup/health')
    toast.add({ title: values ? 'Removed' : 'Saved', color: 'success' })
  }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = '' }
}
const remove = (key: IntegrationKey) => save(`remove-${key}`, [key], { [key]: null })
async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}
</script>

<template>
  <section class="min-w-0 space-y-6">
    <SettingsHeader title="Integrations" description="Connect outside services here. Keys are stored encrypted and never shown again." />
    <LayoutSkeleton v-if="query.isPending.value" variant="form" />
    <LayoutLoadError v-else-if="query.error.value" message="Integrations could not be loaded." :retry="query.refetch" />
    <template v-else-if="data">
      <UAlert v-if="error" color="error" title="Not saved" :description="error" />

      <article class="space-y-3 rounded-lg border border-default p-4">
        <div class="flex flex-wrap items-center gap-2"><h3 class="flex-1 font-medium">Web search</h3><UBadge :label="statusLabel(data.status.search)" color="neutral" variant="subtle" /></div>
        <p class="text-sm text-muted">Lets Agents with Research the web search the internet. Use an Exa key, or an OpenRouter model under Models → AI functions, which costs extra.</p>
        <SettingsIntegrationField v-model="draft.EXA_API_KEY" label="Exa API key" :status="field('EXA_API_KEY')" :busy="busy === 'remove-EXA_API_KEY'" @remove="remove('EXA_API_KEY')" />
        <UButton label="Save" :loading="busy === 'search'" :disabled="!draft.EXA_API_KEY?.trim()" @click="save('search', ['EXA_API_KEY'])" />
      </article>

      <article class="space-y-3 rounded-lg border border-default p-4">
        <div class="flex flex-wrap items-center gap-2"><h3 class="flex-1 font-medium">Reading web pages</h3><UBadge :label="statusLabel(data.status.pages)" color="neutral" variant="subtle" /></div>
        <template v-if="data.cloudflareNetwork">
          <p class="text-sm text-muted">{{ data.status.pages ? 'This Server reads pages with Cloudflare Browser Run. There is nothing to set up.' : 'This Server has no Browser Run binding. Update it from Deployment to add one.' }}</p>
        </template>
        <template v-else>
          <p class="text-sm text-muted">Use the Cloudflare account below, or your own Chromium. Keep Chromium on a private network: anyone who reaches it controls the browser.</p>
          <SettingsIntegrationField v-model="draft.BROWSER_CDP_URL" label="Chromium address" placeholder="http://chromium:9222" :status="field('BROWSER_CDP_URL')" :busy="busy === 'remove-BROWSER_CDP_URL'" @remove="remove('BROWSER_CDP_URL')" />
          <UButton label="Save" :loading="busy === 'pages'" :disabled="!draft.BROWSER_CDP_URL?.trim()" @click="save('pages', ['BROWSER_CDP_URL'])" />
        </template>
      </article>

      <template v-if="!data.cloudflareNetwork">
        <article class="space-y-3 rounded-lg border border-default p-4">
          <h3 class="font-medium">Cloudflare account</h3>
          <p class="text-sm text-muted">One account for Workers AI models, reading pages, sending mail and Live calls on a Server outside Cloudflare. The API token needs Workers AI, Browser Run, Email Sending and Realtime permissions, for whichever of these you use.</p>
          <SettingsIntegrationField v-model="draft.CLOUDFLARE_ACCOUNT_ID" label="Account ID" plain :status="field('CLOUDFLARE_ACCOUNT_ID')" :busy="busy === 'remove-CLOUDFLARE_ACCOUNT_ID'" @remove="remove('CLOUDFLARE_ACCOUNT_ID')" />
          <SettingsIntegrationField v-model="draft.CLOUDFLARE_API_TOKEN" label="API token" :status="field('CLOUDFLARE_API_TOKEN')" :busy="busy === 'remove-CLOUDFLARE_API_TOKEN'" @remove="remove('CLOUDFLARE_API_TOKEN')" />
          <UButton label="Save" :loading="busy === 'cloudflare'" :disabled="!draft.CLOUDFLARE_ACCOUNT_ID?.trim() && !draft.CLOUDFLARE_API_TOKEN?.trim()" @click="save('cloudflare', ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'])" />
        </article>

        <article class="space-y-3 rounded-lg border border-default p-4">
          <div class="flex flex-wrap items-center gap-2"><h3 class="flex-1 font-medium">Sending mail</h3><UBadge :label="statusLabel(data.status.outbound)" color="neutral" variant="subtle" /></div>
          <p class="text-sm text-muted">Uses the Cloudflare account above when there is one. Otherwise, connect an HTTP service that accepts L4's mail message. An SMTP gateway does the same and relays it over SMTP.</p>
          <SettingsIntegrationField v-model="draft.MAIL_GATEWAY_URL" label="Mail gateway URL" plain placeholder="https://mail.example.com/send" :status="field('MAIL_GATEWAY_URL')" :busy="busy === 'remove-MAIL_GATEWAY_URL'" @remove="remove('MAIL_GATEWAY_URL')" />
          <SettingsIntegrationField v-model="draft.MAIL_GATEWAY_TOKEN" label="Mail gateway token" :status="field('MAIL_GATEWAY_TOKEN')" :busy="busy === 'remove-MAIL_GATEWAY_TOKEN'" @remove="remove('MAIL_GATEWAY_TOKEN')" />
          <SettingsIntegrationField v-model="draft.SMTP_GATEWAY_URL" label="SMTP gateway URL" plain placeholder="https://smtp-relay.example.com/send" :status="field('SMTP_GATEWAY_URL')" :busy="busy === 'remove-SMTP_GATEWAY_URL'" @remove="remove('SMTP_GATEWAY_URL')" />
          <SettingsIntegrationField v-model="draft.SMTP_GATEWAY_TOKEN" label="SMTP gateway token" :status="field('SMTP_GATEWAY_TOKEN')" :busy="busy === 'remove-SMTP_GATEWAY_TOKEN'" @remove="remove('SMTP_GATEWAY_TOKEN')" />
          <UButton label="Save" :loading="busy === 'outbound'" :disabled="!['MAIL_GATEWAY_URL', 'MAIL_GATEWAY_TOKEN', 'SMTP_GATEWAY_URL', 'SMTP_GATEWAY_TOKEN'].some(key => draft[key as IntegrationKey]?.trim())" @click="save('outbound', ['MAIL_GATEWAY_URL', 'MAIL_GATEWAY_TOKEN', 'SMTP_GATEWAY_URL', 'SMTP_GATEWAY_TOKEN'])" />
        </article>

        <article class="space-y-3 rounded-lg border border-default p-4">
          <div class="flex flex-wrap items-center gap-2"><h3 class="flex-1 font-medium">Receiving mail</h3><UBadge :label="statusLabel(data.status.inbound)" color="neutral" variant="subtle" /></div>
          <p class="text-sm text-muted">Mail from the internet reaches this Server through a service that posts each message to it.</p>
          <UFormField label="Service"><USelect v-model="inbound" :items="inboundOptions" value-key="value" aria-label="Inbound mail service" class="w-full" /></UFormField>

          <template v-if="inbound === 'postmark'">
            <p class="text-sm text-muted">Generate a secret and save it. L4 then gives you the webhook address to paste into your Postmark server's inbound settings.</p>
            <SettingsIntegrationField v-model="draft.POSTMARK_INBOUND_SECRET" label="Webhook secret" plain :status="field('POSTMARK_INBOUND_SECRET')" :busy="busy === 'remove-POSTMARK_INBOUND_SECRET'" @remove="remove('POSTMARK_INBOUND_SECRET')" />
            <UButton v-if="!managed('POSTMARK_INBOUND_SECRET')" label="Generate secret" color="neutral" variant="outline" @click="generate('POSTMARK_INBOUND_SECRET')" />
            <UAlert v-if="postmarkAddress" color="warning" title="Copy this address now" description="It contains the secret and is shown only once. Paste it into Postmark as the inbound webhook." :actions="[{ label: 'Copy address', color: 'neutral', variant: 'outline', onClick: () => copy(postmarkAddress) }]" />
          </template>
          <template v-else-if="inbound === 'mailgun'">
            <p class="text-sm text-muted">Create a Mailgun route that forwards to this address, and paste the HTTP webhook signing key from Mailgun. It is not the API key.</p>
            <SettingsIntegrationWebhook :url="data.webhooks.mailgun" @copy="copy" />
            <SettingsIntegrationField v-model="draft.MAILGUN_WEBHOOK_SIGNING_KEY" label="Webhook signing key" :status="field('MAILGUN_WEBHOOK_SIGNING_KEY')" :busy="busy === 'remove-MAILGUN_WEBHOOK_SIGNING_KEY'" @remove="remove('MAILGUN_WEBHOOK_SIGNING_KEY')" />
          </template>
          <template v-else-if="inbound === 'ses'">
            <p class="text-sm text-muted">Send Amazon SES receipts to an SNS topic, subscribe this address to it, and paste the topic's ARN.</p>
            <SettingsIntegrationWebhook :url="data.webhooks.ses" @copy="copy" />
            <SettingsIntegrationField v-model="draft.SES_SNS_TOPIC_ARN" label="SNS topic ARN" plain placeholder="arn:aws:sns:us-east-1:123456789012:llll-inbound" :status="field('SES_SNS_TOPIC_ARN')" :busy="busy === 'remove-SES_SNS_TOPIC_ARN'" @remove="remove('SES_SNS_TOPIC_ARN')" />
          </template>
          <template v-else>
            <p class="text-sm text-muted">For your own service that signs each message with this secret, such as the Cloudflare Email Routing bridge.</p>
            <SettingsIntegrationWebhook :url="data.webhooks.bridge" @copy="copy" />
            <SettingsIntegrationField v-model="draft.INBOUND_EMAIL_SECRET" label="Signing secret" plain :status="field('INBOUND_EMAIL_SECRET')" :busy="busy === 'remove-INBOUND_EMAIL_SECRET'" @remove="remove('INBOUND_EMAIL_SECRET')" />
            <UButton v-if="!managed('INBOUND_EMAIL_SECRET')" label="Generate secret" color="neutral" variant="outline" @click="generate('INBOUND_EMAIL_SECRET')" />
          </template>
          <UButton label="Save" :loading="busy === 'inbound'" :disabled="!draft[inboundKey[inbound]]?.trim()" @click="save('inbound', [inboundKey[inbound]])" />
          <p v-if="saved(inboundKey[inbound])" class="text-xs text-muted">A saved value stays hidden. Saving a new one replaces it, and your service must then use the new one.</p>
        </article>
      </template>
    </template>
  </section>
</template>

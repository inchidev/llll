<script setup lang="ts">
const route = useRoute()
const method = ref(route.query.method === 'vps' ? 'vps' : 'cloudflare')
const name = ref('My L4')
const accountId = ref('')
const busy = ref(false)
const error = ref('')
const config = ref<{ oauth: boolean } | null>(null)
const session = ref<{ authorized: boolean; accounts: { id: string; name: string }[]; step?: number; name?: string; version?: string; grantExpiresIn?: number; error?: string; completed?: boolean; claim?: string; origin?: string } | null>(null)
const versions = ref<{ version: string; name: string; published_at: string; notes_url: string }[]>([])
const version = ref('')
const releasesError = ref('')
const phases = ['Create database and backup storage', 'Upload application and configure credentials', 'Verify installation', 'Ready']
const now = ref(Date.now())
const grantExpiresAt = ref(0)
const grantLeft = computed(() => {
  if (!session.value?.authorized || session.value.completed || !grantExpiresAt.value) return ''
  const seconds = Math.max(0, Math.round((grantExpiresAt.value - now.value) / 1000))
  return `Cloudflare authorization: ~${Math.floor(seconds / 60)} min left, renews automatically while deploying.`
})
async function refresh() {
  try { session.value = await $fetch('/api/deploy/session'); accountId.value ||= session.value?.accounts[0]?.id || ''; error.value = session.value?.error || '' }
  catch (cause) { if ((cause as { status?: number }).status !== 401) error.value = 'Could not load deployment state' }
  if (session.value?.grantExpiresIn !== undefined) grantExpiresAt.value = Date.now() + session.value.grantExpiresIn * 1000
}
async function deploy() {
  busy.value = true; error.value = ''
  try {
    if (session.value?.step === undefined) await $fetch('/api/deploy/start', { method: 'POST', body: { accountId: accountId.value, name: name.value, version: version.value } })
    await refresh()
    while (!session.value?.completed) { await $fetch('/api/deploy/advance', { method: 'POST', timeout: 150000 }); await refresh() }
  } catch (cause) { error.value = (cause as { data?: { error?: { message?: string } } }).data?.error?.message || 'Deployment paused. Retry to resume the same installation.' }
  finally { busy.value = false }
}
onMounted(async () => {
  config.value = await $fetch('/api/deploy/config'); await refresh()
  setInterval(() => { now.value = Date.now() }, 1000)
  try {
    const data = await $fetch<{ releases: { version: string; name: string; published_at: string; notes_url: string }[] }>('/api/deploy/releases')
    versions.value = data.releases
    version.value = session.value?.version || data.releases[0]?.version || ''
  } catch { releasesError.value = 'Could not load the release list. Enter a version like v0.3.1.' }
})
useSeoMeta({ title: 'Install L4 on your infrastructure' })
</script>
<template>
  <UContainer class="max-w-3xl py-8 sm:py-16">
    <BrandLogo />
    <h1 class="mt-12 text-4xl font-semibold tracking-tight">Install your own L4</h1>
    <p class="mt-4 text-muted">Your accounts, servers and data. Free MIT software.</p>
    <UTabs v-if="session == null || (session.step === undefined && !session.completed)" v-model="method" class="mt-8" :items="[{ label: 'Cloudflare', value: 'cloudflare' }, { label: 'VPS / Coolify', value: 'vps' }]" />
    <section v-if="method === 'cloudflare'" class="mt-8 space-y-6">
      <p v-if="grantLeft" class="text-sm text-muted">{{ grantLeft }}</p>
      <template v-if="session?.completed">
        <h2 class="text-2xl font-semibold">Your installation is ready</h2>
        <p class="text-muted">Create its owner, save the recovery key, then create your first server.</p>
        <UButton :to="session.claim" external label="Create installation owner" size="lg" />
        <p class="break-all text-sm text-muted">{{ session.origin }}</p>
      </template>
      <template v-else-if="session && (session.authorized || session.step !== undefined)">
        <template v-if="session.step === undefined">
          <UFormField label="Cloudflare account"><USelect v-model="accountId" :items="session.accounts.map(a => ({label:a.name,value:a.id}))" class="w-full" /></UFormField>
          <UFormField label="Installation name"><UInput v-model="name" class="w-full" maxlength="80" /></UFormField>
          <UFormField label="Release version">
            <USelect v-if="versions.length" v-model="version" :items="versions.map(r => ({label: r.published_at ? `${r.version} — ${r.published_at.slice(0, 10)}` : r.version, value: r.version}))" class="w-full" />
            <UInput v-else v-model="version" placeholder="v0.3.1" class="w-full" />
            <template #hint><a href="https://github.com/inchidev/llll/releases" target="_blank" rel="noopener" class="underline">Published GitHub releases</a>, newest first</template>
          </UFormField>
          <p v-if="releasesError && !versions.length" class="text-sm text-muted">{{ releasesError }}</p>
        </template>
        <ol v-else class="space-y-4"><li v-for="(phase,index) in phases" :key="phase" class="flex items-center gap-3" :class="index > (session.step || 0) ? 'text-dimmed' : 'text-highlighted'"><UIcon :name="index < (session.step || 0) ? 'i-ph-check-circle' : 'i-ph-circle'" class="size-5" />{{ phase }}</li></ol>
        <p v-if="session.step !== undefined && session.version" class="text-sm text-muted">Release {{ session.version }}</p>
        <UButton :label="session.step === undefined ? 'Deploy installation' : 'Resume deployment'" :loading="busy" :disabled="session.step === undefined && !version" size="lg" @click="deploy" />
      </template>
      <template v-else>
        <p class="text-muted">Authorize L4 to deploy into your Cloudflare account. Its credentials are handed to your installation after deployment.</p>
        <UButton to="/api/deploy/oauth" external label="Connect Cloudflare" icon="i-ph-cloud" size="lg" :disabled="!config?.oauth" />
        <p v-if="config && !config.oauth" class="text-sm text-muted">The deployment service is awaiting its OAuth configuration. <a href="https://github.com/inchidev/llll/blob/main/docs/deployment.md" class="underline">Manual setup</a> remains available.</p>
        <p class="text-sm text-muted">Cloudflare bills infrastructure usage directly. Enable R2 before deploying.</p>
      </template>
      <UAlert v-if="error" color="error" :description="error" /><UButton v-if="error && session?.step !== undefined" to="/api/deploy/oauth?resume=1" external label="Reconnect Cloudflare" color="neutral" variant="outline" />
    </section>
    <section v-else class="mt-8 space-y-6">
      <h2 class="text-2xl font-semibold">celld + Docker Compose</h2>
      <p class="text-muted">Generate a private installation with isolated server services. Run it on your VPS or import the Compose project into Coolify, then configure HTTPS.</p>
      <pre class="overflow-x-auto rounded-lg border border-default p-4 text-xs leading-6">git clone https://github.com/inchidev/llll.git
cd llll
node scripts/self-host-installation.mjs .deployment/my-l4 https://chat.example.com main games
docker compose -f .deployment/my-l4/compose.json up -d --build</pre>
      <p class="text-sm text-muted">Keep generated credentials private. Open the owner claim link, then register the generated servers. Automatic SSH deployment is not available yet.</p>
      <UButton to="https://github.com/inchidev/llll/blob/main/docs/deployment.md" label="VPS deployment guide" color="neutral" variant="outline" external />
    </section>
  </UContainer>
</template>

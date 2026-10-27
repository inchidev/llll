<script setup lang="ts">
definePageMeta({ layout: 'auth', middleware: ['auth'] })
useHead({ title: 'Finish GitHub connection', meta: [{ name: 'referrer', content: 'no-referrer' }, { name: 'robots', content: 'noindex' }] })
const route = useRoute()
const { api } = useApi()
const resuming = ref(false), failure = ref('')
const valid = computed(() => typeof route.query.code === 'string' && /^[a-zA-Z0-9_-]{1,200}$/u.test(route.query.code) && typeof route.query.state === 'string' && /^[a-f0-9]{64}$/u.test(route.query.state))
const expired = computed(() => route.query.expired === '1')
function finish() { window.location.replace('/api/git-connections/github/callback?' + new URLSearchParams({ code: route.query.code as string, state: route.query.state as string })) }
async function resume() {
  resuming.value = true
  try { await api('/api/git-connections/github/resume', { method: 'POST', body: { state: route.query.state } }); finish() }
  catch (error) { failure.value = errorMessage(error); resuming.value = false }
}
onMounted(() => {
  if (valid.value && !expired.value) finish()
})
</script>

<template>
  <div class="space-y-4">
    <p>{{ !valid ? 'This GitHub setup link is invalid. Return to Repositories settings and start again.' : expired ? 'This setup took longer than expected. Resume the existing connection to finish without creating another App.' : 'Finishing your GitHub connection…' }}</p>
    <UAlert v-if="failure" color="error" :title="failure" />
    <UButton v-if="valid && expired" label="Resume connection" :loading="resuming" @click="resume" />
  </div>
</template>

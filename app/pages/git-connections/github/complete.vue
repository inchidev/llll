<script setup lang="ts">
definePageMeta({ layout: 'auth', middleware: ['auth'] })
useHead({ title: 'Finish GitHub connection', meta: [{ name: 'referrer', content: 'no-referrer' }, { name: 'robots', content: 'noindex' }] })
const route = useRoute()
const valid = computed(() => typeof route.query.code === 'string' && /^[a-zA-Z0-9_-]{1,200}$/u.test(route.query.code) && typeof route.query.state === 'string' && /^[a-f0-9]{64}$/u.test(route.query.state))
onMounted(() => {
  if (valid.value) window.location.replace('/api/git-connections/github/callback?' + new URLSearchParams({ code: route.query.code as string, state: route.query.state as string }))
})
</script>

<template>
  <p>{{ valid ? 'Finishing your GitHub connection…' : 'This GitHub setup link is invalid. Return to Repositories settings and start again.' }}</p>
</template>

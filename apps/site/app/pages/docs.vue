<script setup lang="ts">
const config = useRuntimeConfig()
const sections = [
  { title: 'Instance', description: 'Accounts, sign-in and your directory of Servers.', path: 'instance.md' },
  { title: 'Server', description: 'Community data, permissions, files and live coordination.', path: 'architecture.md' },
  { title: 'Shell', description: 'Connect to Instances and use their own Clients.', path: 'instance.md#web-pwa-and-telegram' },
  { title: 'Deployment', description: 'PR previews, protected main and immutable releases.', path: 'deployment.md' },
  { title: 'Releases', description: 'Install a published version and understand its limits.', path: 'releases.md' },
]
useHead({ title: 'L4 documentation' })
</script>
<template>
  <UContainer class="max-w-4xl py-12 sm:py-20">
    <UButton to="/" label="L4" color="neutral" variant="link" icon="i-ph-arrow-left" />
    <h1 class="mt-8 text-4xl font-semibold">Documentation</h1>
    <p class="mt-4 text-muted">Instance, Server, Shell, Landing and Docs are the five parts of L4. The official web deployment serves Landing, Shell and this documentation index. Your Instance and Servers run on your infrastructure.</p>
    <div class="mt-10 grid gap-4 sm:grid-cols-2">
      <a v-for="section in sections" :key="section.title" :href="`https://github.com/inchidev/llll/blob/${config.public.docsRef}/docs/${section.path}`" class="rounded-xl border border-default p-5 hover:bg-elevated"><h2 class="text-lg font-semibold">{{ section.title }}</h2><p class="mt-2 text-sm text-muted">{{ section.description }}</p></a>
    </div>
  </UContainer>
</template>

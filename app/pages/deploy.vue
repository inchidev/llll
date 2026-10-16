<script setup lang="ts">
definePageMeta({ layout: 'default' })
</script>
<template>
  <main class="h-full overflow-y-auto p-6 sm:p-12"><div class="mx-auto max-w-2xl space-y-8">
    <UButton to="/connections" label="Back to connections" icon="i-ph-arrow-left" color="neutral" variant="link" />
    <header><p class="text-xs font-semibold uppercase tracking-widest text-primary">L4 · Own your installation</p><h1 class="mt-3 text-4xl font-semibold">Your servers. Your infrastructure.</h1><p class="mt-4 text-muted">One installation, several communities. Every server has its own database, files and live coordination. Use the shared L4 client or the client hosted on your own address.</p></header>
    <div class="grid gap-4 sm:grid-cols-2"><section class="rounded-2xl border border-default p-5"><UIcon name="i-ph-cloud" class="size-7 text-primary" /><h2 class="mt-4 text-lg font-semibold">Cloudflare</h2><p class="mt-2 text-sm text-muted">Deploy the installation and provision isolated servers in your own account.</p><UButton class="mt-5" to="https://github.com/inchidev/llll/blob/main/docs/installation.md" target="_blank" label="Installation guide" /></section><section class="rounded-2xl border border-default p-5"><UIcon name="i-ph-hard-drives" class="size-7 text-primary" /><h2 class="mt-4 text-lg font-semibold">Your VPS</h2><p class="mt-2 text-sm text-muted">Run celld and S3 storage with Docker Compose or deploy through Coolify.</p><UButton class="mt-5" to="https://github.com/inchidev/llll/tree/main/self-host" target="_blank" label="Self-host guide" color="neutral" variant="outline" /></section></div>
    <p class="text-sm text-muted">Backups use a separately configured private bucket. Optional calls, email and AI connect to your chosen providers.</p>
  </div></main>
</template>

<script setup lang="ts">
const repoUrl = 'https://github.com/inchidev/llll'
const columns = [
  { label: 'Product', links: [
    { label: 'Agents', to: '/#agents' },
    { label: 'Features', to: '/#product' },
    { label: 'Ways to run', to: '/#run' },
    { label: 'Create a Server', to: '/create?tab=cloudflare' },
    { label: 'My Servers', to: '/servers' },
  ] },
  { label: 'Docs', links: [
    { label: 'Get started', to: '/docs/get-started/what-is-l4' },
    { label: 'Cloudflare', to: '/docs/cloudflare/overview' },
    { label: 'Self-host', to: '/docs/self-host/vps' },
    { label: 'Agents and MCP', to: '/docs/agents/overview' },
    { label: 'Docs for agents (llms.txt)', to: '/llms.txt', external: true },
  ] },
  { label: 'Project', links: [
    { label: 'Changelog', to: '/changelog' },
    { label: 'Blog', to: '/blog' },
    { label: 'GitHub', to: repoUrl, external: true },
    { label: 'Issues and feedback', to: `${repoUrl}/issues`, external: true },
    { label: 'Privacy', to: '/privacy' },
    { label: 'Terms', to: '/terms' },
  ] },
]
</script>

<template>
  <footer class="border-t border-muted pt-12 sm:pt-16">
    <UContainer>
      <div class="grid grid-cols-2 gap-8 pb-12 sm:grid-cols-3 sm:pb-16">
        <nav v-for="column in columns" :key="column.label" :aria-label="`Footer ${column.label.toLowerCase()}`">
          <p class="mb-4 text-sm font-semibold text-highlighted">{{ column.label }}</p>
          <ul class="space-y-3 text-sm text-muted">
            <li v-for="link in column.links" :key="link.label">
              <ULink :to="link.to" :external="link.external" :target="link.to.startsWith('http') ? '_blank' : undefined" class="hover:text-highlighted">{{ link.label }}</ULink>
            </li>
          </ul>
        </nav>
      </div>
    </UContainer>
    <div class="border-t border-muted py-8">
      <UContainer class="flex w-full flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <BrandLogo />
        <p class="text-xs leading-5 text-dimmed">MIT License · Made by <a href="https://inchi.dev" class="hover:text-highlighted">Inchi</a></p>
      </UContainer>
    </div>
  </footer>
</template>

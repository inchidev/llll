<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const props = defineProps<{ items?: NavigationMenuItem[] }>()
const repoUrl = 'https://github.com/inchidev/llll'
const navigation = computed<NavigationMenuItem[]>(() => props.items || [
  { label: 'Docs', to: '/docs' },
  { label: 'Changelog', to: '/changelog' },
  { label: 'Blog', to: '/blog' },
])
</script>

<template>
  <UHeader to="/" title="L4" class="border-b border-muted/70 bg-default/80 backdrop-blur-xl">
    <template #title><BrandLogo :linked="false" /></template>
    <UNavigationMenu :items="navigation" />
    <template #right>
      <slot name="right" />
      <UButton to="/servers" label="My Servers" color="neutral" variant="ghost" class="hidden sm:inline-flex" />
      <UButton :to="repoUrl" target="_blank" icon="i-ph-github-logo" aria-label="GitHub repository" color="neutral" variant="ghost" />
    </template>
    <template #body>
      <UNavigationMenu :items="[...navigation, { label: 'My Servers', to: '/servers' }]" orientation="vertical" class="-mx-2.5" />
      <slot name="body" />
    </template>
  </UHeader>
</template>

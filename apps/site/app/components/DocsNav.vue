<script setup lang="ts">
defineProps<{ navigation: { id: string, title: string, pages: { title: string, url: string }[] }[], current: string }>()
</script>

<template>
  <nav aria-label="Documentation" class="space-y-6 text-sm">
    <NuxtLink to="/docs" class="block font-semibold" :class="current === '/docs' ? 'text-primary' : 'text-highlighted hover:text-primary'">Overview</NuxtLink>
    <div v-for="section in navigation" :key="section.id">
      <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-dimmed">{{ section.title }}</p>
      <ul class="space-y-0.5 border-l border-muted">
        <li v-for="item in section.pages" :key="item.url">
          <NuxtLink :to="item.url" :aria-current="item.url === current ? 'page' : undefined" class="-ml-px block border-l py-1 pl-3" :class="item.url === current ? 'border-primary font-medium text-primary' : 'border-transparent text-muted hover:border-accented hover:text-highlighted'">{{ item.title }}</NuxtLink>
        </li>
      </ul>
    </div>
  </nav>
</template>

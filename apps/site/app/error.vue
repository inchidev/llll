<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()
const missing = computed(() => props.error.statusCode === 404)
useHead({ title: missing.value ? 'Page not found · L4' : 'Something went wrong · L4', meta: [{ name: 'robots', content: 'noindex' }] })
</script>

<template>
  <UApp>
    <div class="flex min-h-screen flex-col bg-default text-default">
      <SiteHeader />
      <UContainer class="flex flex-1 flex-col items-center justify-center py-24 text-center">
        <p class="text-sm font-semibold text-dimmed">{{ error.statusCode }}</p>
        <h1 class="mt-3 text-4xl font-semibold text-highlighted">{{ missing ? 'Page not found' : 'Something went wrong' }}</h1>
        <p class="mt-4 max-w-md text-muted">{{ missing ? 'This address is not part of llll.gg. It may have moved into the documentation.' : 'Reload the page or try again later.' }}</p>
        <div class="mt-8 flex flex-col gap-3 sm:flex-row">
          <UButton label="Documentation" to="/docs" @click="clearError({ redirect: '/docs' })" />
          <UButton label="Home" to="/" color="neutral" variant="outline" @click="clearError({ redirect: '/' })" />
        </div>
      </UContainer>
      <SiteFooter />
    </div>
  </UApp>
</template>

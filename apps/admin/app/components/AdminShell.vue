<script setup lang="ts">
import type { AdminSession } from '../composables/useAdmin'

const session = useState<AdminSession | null>('admin-session')

async function signOut() {
  await adminFetch('/api/logout', { method: 'POST' })
  await navigateTo('/login')
}
</script>

<template>
  <div class="min-h-dvh bg-default">
    <header class="border-b border-default">
      <div class="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
        <NuxtLink to="/" class="flex items-center gap-2 font-semibold text-highlighted">
          <span class="grid size-7 place-items-center rounded-md bg-primary text-sm font-bold text-inverted">#</span>
          L4 Admin
        </NuxtLink>
        <UBadge v-if="session?.version" :label="`v${session.version}`" color="neutral" variant="subtle" size="sm" />
        <div class="ms-auto flex items-center gap-2">
          <span class="hidden text-sm text-muted sm:block">{{ session?.owner?.email }}</span>
          <UButton v-if="session?.owner" label="Sign out" color="neutral" variant="ghost" size="sm" @click="signOut" />
        </div>
      </div>
    </header>
    <main class="mx-auto max-w-5xl px-4 py-8">
      <slot />
    </main>
  </div>
</template>

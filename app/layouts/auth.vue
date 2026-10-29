<script setup lang="ts">
import ServerAvatar from '../../packages/client-ui/ServerAvatar.vue'
import { DEFAULT_APP_NAME } from '~~/shared/app-branding'

const session = useSessionStore()

// The sign-in stage carries only this Server's mark; the form is the page.
const appName = computed(() => session.health?.appName || DEFAULT_APP_NAME)

useHead(() => ({ title: appName.value }))
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto bg-default lg:grid lg:grid-cols-[var(--df-auth-stage-width)_minmax(0,1fr)]">
    <aside class="flex min-w-0 flex-col border-b border-default bg-muted dark:bg-black px-6 pb-6 pt-[max(1.5rem,var(--df-safe-area-top))] sm:px-8 lg:min-h-full lg:border-r lg:border-b-0 lg:p-10 lg:pb-[max(2.5rem,var(--df-safe-area-bottom))] lg:pt-[max(2.5rem,var(--df-safe-area-top))] xl:p-12">
      <BrandWordmark :name="appName" size="lg">
        <template v-if="session.health?.iconUrl" #icon><ServerAvatar :name="appName" :icon-url="session.health.iconUrl" class="size-10 rounded-lg bg-accented" /></template>
      </BrandWordmark>
    </aside>

    <main class="flex min-w-0 flex-col lg:min-h-full">
      <div class="flex flex-1 items-center justify-center px-6 pb-[max(2rem,var(--df-safe-area-bottom))] pt-8 sm:px-8 sm:py-12 lg:py-16">
        <div class="w-full min-w-0 max-w-[26rem]">
          <slot />
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import ServerAvatar from '../../packages/client-ui/ServerAvatar.vue'
import { DEFAULT_APP_NAME } from '~~/shared/app-branding'

const session = useSessionStore()

// The sign-in stage introduces this Server, not the L4 product: invited
// Members arrive for the community, and the product credit stays small.
const appName = computed(() => session.health?.appName || DEFAULT_APP_NAME)

useHead(() => ({ title: appName.value }))
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto bg-default lg:grid lg:grid-cols-[var(--df-auth-stage-width)_minmax(0,1fr)]">
    <aside class="flex min-w-0 flex-col border-b border-default bg-muted px-6 pb-6 pt-[max(1.5rem,var(--df-safe-area-top))] sm:px-8 lg:min-h-full lg:border-r lg:border-b-0 lg:p-10 lg:pb-[max(2.5rem,var(--df-safe-area-bottom))] lg:pt-[max(2.5rem,var(--df-safe-area-top))] xl:p-12">
      <BrandWordmark :name="appName" size="lg">
        <template v-if="session.health?.iconUrl" #icon><ServerAvatar :name="appName" :icon-url="session.health.iconUrl" class="size-10 rounded-lg bg-accented" /></template>
      </BrandWordmark>

      <div class="hidden flex-1 items-center py-12 lg:flex">
        <div class="max-w-lg">
          <h1 class="font-brand text-3xl sm:text-4xl xl:text-5xl font-semibold tracking-[-0.045em] text-highlighted leading-[1.05] break-words">
            {{ appName }}
          </h1>
          <p class="mt-7 max-w-md text-base xl:text-lg leading-relaxed text-muted">
            Conversations, projects and tasks for this Server’s people and agents.
          </p>
        </div>
      </div>

      <a href="https://llll.gg" target="_blank" rel="noopener" class="hidden text-xs text-dimmed hover:text-muted lg:block">Powered by L4</a>
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

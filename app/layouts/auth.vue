<script setup lang="ts">
import {
  DEFAULT_APP_NAME,
  DEFAULT_APP_SUBTITLE,
  DEFAULT_APP_TITLE,
} from '~~/shared/app-branding'

const session = useSessionStore()

const appName = computed(() => session.health?.appName || DEFAULT_APP_NAME)
const appTitle = computed(() => session.health?.appTitle || DEFAULT_APP_TITLE)
const appSubtitle = computed(() => session.health?.appSubtitle || DEFAULT_APP_SUBTITLE)
const appTitleLines = computed(() => appTitle.value
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean))

useHead(() => ({ title: appName.value }))
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto bg-default lg:grid lg:grid-cols-[var(--df-auth-stage-width)_minmax(0,1fr)]">
    <aside class="flex min-w-0 flex-col border-b border-default bg-muted px-6 pb-6 pt-[max(1.5rem,var(--df-safe-area-top))] sm:px-8 lg:min-h-full lg:border-r lg:border-b-0 lg:p-10 lg:pb-[max(2.5rem,var(--df-safe-area-bottom))] lg:pt-[max(2.5rem,var(--df-safe-area-top))] xl:p-12">
      <BrandWordmark :name="appName" size="lg" />

      <div class="hidden flex-1 items-center py-12 lg:flex">
        <div class="max-w-lg">
          <h1 class="font-brand text-3xl sm:text-4xl xl:text-5xl font-semibold tracking-[-0.045em] text-highlighted leading-[1] break-words">
            <span
              v-for="(line, index) in appTitleLines"
              :key="`${index}-${line}`"
              class="block"
              :class="{ 'text-primary': appTitleLines.length > 1 && index === appTitleLines.length - 1 }"
            >{{ line }}</span>
          </h1>
          <p class="mt-7 max-w-md text-base xl:text-lg leading-relaxed text-muted">
            {{ appSubtitle }}
          </p>
        </div>
      </div>
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

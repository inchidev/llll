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
    <aside class="auth-stage relative flex min-h-[22rem] flex-col overflow-hidden border-b border-default bg-elevated p-6 pb-[max(1.5rem,var(--df-safe-area-bottom))] pt-[max(1.5rem,var(--df-safe-area-top))] sm:min-h-[26rem] sm:p-8 sm:pb-[max(2rem,var(--df-safe-area-bottom))] sm:pt-[max(2rem,var(--df-safe-area-top))] lg:min-h-full lg:border-r lg:border-b-0 lg:p-10 lg:pb-[max(2.5rem,var(--df-safe-area-bottom))] lg:pt-[max(2.5rem,var(--df-safe-area-top))] xl:p-12 xl:pb-[max(3rem,var(--df-safe-area-bottom))] xl:pt-[max(3rem,var(--df-safe-area-top))]">
      <BrandWordmark :name="appName" size="lg" class="relative z-10" />

      <div class="relative z-10 flex-1 flex items-center">
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

      <div class="auth-shape auth-shape-one" aria-hidden="true" />
      <div class="auth-shape auth-shape-two" aria-hidden="true" />
      <div class="auth-shape auth-shape-three" aria-hidden="true" />
    </aside>

    <main class="auth-panel relative flex min-h-[28rem] flex-col lg:min-h-full">
      <div class="relative z-10 flex flex-1 items-center justify-center px-6 pb-[max(3rem,var(--df-safe-area-bottom))] pt-[max(3rem,var(--df-safe-area-top))]">
        <div class="w-full max-w-[26rem] sm:rounded-2xl sm:border sm:border-default sm:bg-elevated/60 sm:p-8 sm:shadow-xl sm:shadow-black/20 sm:backdrop-blur-sm">
          <slot />
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.auth-stage {
  background-image: radial-gradient(
    circle,
    color-mix(in srgb, var(--ui-text-dimmed) 22%, transparent) 1px,
    transparent 1px
  );
  background-size: 28px 28px;
}

.auth-panel::before {
  content: '';
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 60%;
  pointer-events: none;
  background: radial-gradient(
    75% 60% at 50% 0%,
    color-mix(in srgb, var(--ui-primary) 7%, transparent),
    transparent 70%
  );
}

.auth-shape {
  position: absolute;
  border: 1px solid color-mix(in srgb, var(--ui-primary) 24%, transparent);
  background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg-elevated));
  box-shadow: inset 0 1px 0 color-mix(in srgb, white 12%, transparent);
}

.auth-shape-one {
  width: 18rem;
  height: 9rem;
  right: -6rem;
  top: 19%;
  border-radius: 4.5rem 1.5rem 4.5rem 4.5rem;
  transform: rotate(-11deg);
}

.auth-shape-two {
  width: 12rem;
  height: 6rem;
  left: -4rem;
  bottom: 13%;
  border-radius: 1.5rem 3rem 3rem 3rem;
  transform: rotate(14deg);
}

.auth-shape-three {
  width: 4.5rem;
  height: 4.5rem;
  right: 16%;
  bottom: 9%;
  border-radius: 42% 58% 61% 39% / 51% 38% 62% 49%;
  background: color-mix(in srgb, var(--ui-primary) 72%, var(--ui-bg-elevated));
  transform: rotate(24deg);
}
</style>

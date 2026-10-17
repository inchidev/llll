<script setup lang="ts">
const { installations, active, select, toggle } = useInstallations()
function host(origin: string) { return new URL(origin).host }
function open(origin: string, serverId: string) {
  if (active.value?.origin === origin && active.value.serverId === serverId) return
  select(origin, serverId)
  window.location.assign('/')
}
</script>

<template>
  <nav aria-label="Installations and servers" class="flex h-full w-[84px] shrink-0 flex-col gap-3 overflow-y-auto border-e border-default bg-elevated px-2 pb-[max(0.5rem,var(--df-safe-area-bottom))] pt-[max(0.5rem,var(--df-safe-area-top))]">
    <NuxtLink to="/connections" aria-label="L4 connections" class="mx-auto flex size-11 items-center justify-center rounded-2xl bg-primary/15 text-primary"><BrandLogo class="size-7" /></NuxtLink>
    <section v-for="installation in installations" :key="installation.origin" :aria-label="installation.name" class="relative grid min-h-24 grid-cols-[14px_1fr] gap-1">
      <button :title="`${installation.name} · ${host(installation.origin)}`" class="relative rounded bg-accented text-[10px] font-semibold text-muted hover:text-highlighted" :aria-label="`Toggle ${installation.name}`" :aria-expanded="!installation.collapsed" @click="toggle(installation.origin)"><span class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-90 whitespace-nowrap">{{ installation.name.slice(0, 18) }}</span></button>
      <div v-if="!installation.collapsed" class="space-y-2">
        <UTooltip v-for="server in installation.servers.filter(item => item.status === 'ready')" :key="server.id" :text="server.name" :content="{ side: 'right' }">
          <button class="relative mx-auto flex size-11 items-center justify-center rounded-2xl bg-accented text-sm font-semibold transition hover:rounded-xl hover:bg-primary/15 hover:text-primary" :class="active?.origin === installation.origin && active.serverId === server.id ? 'rounded-xl bg-primary/15 text-primary ring-2 ring-primary' : ''" :aria-label="`${server.name} on ${installation.name}`" :aria-current="active?.origin === installation.origin && active.serverId === server.id ? 'page' : undefined" @click="open(installation.origin, server.id)">
            {{ server.name.split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase() }}
          </button>
        </UTooltip>
        <NuxtLink v-if="!installation.servers.length && !installation.userId" :to="{ path: '/connections', query: { installation: installation.origin } }" class="block text-center text-[10px] text-muted">Sign in</NuxtLink>
      </div>

    </section>
    <UTooltip text="Connect an installation" :content="{ side: 'right' }"><UButton to="/connections" icon="i-ph-plus" color="neutral" variant="soft" square size="lg" aria-label="Connect an installation" class="mx-auto rounded-2xl" /></UTooltip>
  </nav>
</template>

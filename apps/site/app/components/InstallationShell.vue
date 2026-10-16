<script setup lang="ts">
const shell = useShell()
const route = useRoute()
const ownOrigin = ref('')
const address = ref('')
const error = shell.error
const busy = ref(false)
async function connect() {
  busy.value = true; error.value = ''
  try { await shell.connect(address.value) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not connect' }
  finally { busy.value = false }
}
function selectFrame(element: unknown, origin: string) {
  if (element instanceof HTMLIFrameElement) shell.frames.value[origin] = element
}
onMounted(async () => {
  ownOrigin.value = location.origin
  shell.initialize()
  try {
    if (typeof route.query.installation === 'string') await shell.connect(route.query.installation)
    else if (route.params.serverId) await shell.resolveServer()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Server unavailable' }
})
watch(() => route.fullPath, async () => { if (route.params.serverId) { try { await shell.resolveServer() } catch { error.value = 'This server is unavailable. Open its installation directly.' } } })
</script>

<template>
  <main class="flex h-dvh overflow-hidden bg-default">
    <nav aria-label="Installations and servers" class="shell-rail flex w-[86px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-default bg-elevated px-2 py-3">
      <NuxtLink to="/open" aria-label="L4 connections" class="mx-auto flex size-11 items-center justify-center rounded-xl bg-accented text-highlighted"><svg viewBox="0 0 44 32" class="w-7" aria-hidden="true"><rect v-for="x in [0,12,24,36]" :key="x" :x="x" width="8" height="32" rx="2" fill="currentColor" /></svg></NuxtLink>
      <section v-for="installation in shell.installations.value" :key="installation.origin" :aria-label="installation.name" class="relative grid min-h-24 grid-cols-[18px_1fr] gap-1">
        <button :aria-label="`Toggle ${installation.name}`" :aria-expanded="!installation.collapsed" class="relative rounded-md bg-accented text-[10px] font-semibold text-muted hover:text-highlighted" @click="installation.collapsed = !installation.collapsed; shell.persist()"><span class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-90 whitespace-nowrap">{{ installation.name.slice(0, 18) }}</span></button>
        <div v-if="!installation.collapsed" class="flex flex-col gap-2">
          <button v-for="server in installation.servers" :key="server.id" :aria-label="`${server.name} on ${installation.name}`" :aria-current="route.params.serverId === server.id ? 'page' : undefined" :title="server.name" class="relative flex size-11 shrink-0 items-center justify-center rounded-xl bg-accented text-sm font-semibold hover:bg-inverted hover:text-inverted" :class="route.params.serverId === server.id ? 'ring-2 ring-primary' : ''" @click="shell.open(installation, server.id)">{{ server.name.slice(0, 2).toUpperCase() }}<span v-if="server.unread" class="absolute -bottom-1 -right-1 rounded bg-primary px-1 text-[10px] text-black">{{ server.unread }}</span></button>
          <button v-if="!installation.servers.length" :aria-label="`Sign in to ${installation.name}`" class="flex size-11 items-center justify-center rounded-xl border border-default text-muted" @click="shell.open(installation)"><UIcon name="i-ph-sign-in" class="size-5" /></button>
        </div>
      </section>
      <button aria-label="Add an installation" class="mx-auto flex size-11 items-center justify-center rounded-xl text-muted hover:bg-accented" @click="shell.selected.value = ''; navigateTo('/open')"><UIcon name="i-ph-plus" class="size-6" /></button>
      <NuxtLink to="/deploy" aria-label="Deploy L4" class="mx-auto mt-auto flex size-11 items-center justify-center text-muted"><UIcon name="i-ph-cloud-arrow-up" class="size-5" /></NuxtLink>
    </nav>
    <section class="relative min-w-0 flex-1">
      <iframe v-for="origin in shell.loaded.value" v-show="shell.selected.value === origin" :key="origin" :ref="element => selectFrame(element, origin)" :src="`${origin}/connections?parent=${encodeURIComponent(ownOrigin)}`" :title="`${shell.installations.value.find(i => i.origin === origin)?.name || 'L4'} installation`" class="absolute inset-0 h-full w-full border-0" allow="camera; microphone; display-capture; fullscreen; clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerpolicy="no-referrer" />
      <div v-if="!shell.selected.value" class="flex h-full items-center justify-center p-5">
        <form class="w-full max-w-md space-y-5" @submit.prevent="connect">
          <h1 class="text-2xl font-semibold tracking-tight">Open an installation</h1>
          <UFormField label="Address"><UInput v-model="address" placeholder="chat.example.com" class="w-full" size="xl" autocomplete="url" required /></UFormField>
          <UAlert v-if="error" color="error" :description="error" />
          <UButton type="submit" label="Open" :loading="busy" size="lg" block />
          <div class="flex justify-between text-sm text-muted"><NuxtLink to="/deploy">Install your own</NuxtLink><a href="https://sandbox.llll.gg">Try the sandbox</a></div>
        </form>
      </div>
      <UAlert v-else-if="error" class="absolute bottom-4 left-4 right-4" color="error" :description="error" closable @update:open="error = ''" />
    </section>
  </main>
</template>

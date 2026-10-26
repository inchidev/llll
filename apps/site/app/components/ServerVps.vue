<script setup lang="ts">
const domain = ref('chat.example.com'), email = ref('owner@example.com'), factory = ref(false), trust = ref(false)
const valid = computed(() => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain.value) && /^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/iu.test(email.value))
const command = computed(() => [
  'curl -fsSL https://llll.gg/install.sh | sudo env',
  `  LLLL_DOMAIN='${domain.value}'`,
  `  LLLL_ADMIN_EMAIL='${email.value}'`,
  ...(factory.value ? ['  LLLL_FACTORY=true LLLL_SHARED_KERNEL_TRUSTED=1'] : []),
  '  bash',
].join(" \\\n"))
</script>
<template>
  <section class="space-y-5">
    <h2 class="text-2xl font-semibold">Install on your VPS</h2>
    <p class="text-sm text-muted">Use a supported Debian/Ubuntu amd64 VPS with your own domain. The verified release installs L4, Docker Compose and HTTPS; it preserves the Server’s accounts and data on that VPS.</p>
    <UFormField label="Server domain"><UInput v-model="domain" placeholder="chat.example.com" class="w-full" /></UFormField>
    <UFormField label="Owner email"><UInput v-model="email" type="email" class="w-full" /></UFormField>
    <UCheckbox v-model="factory" label="Enable Software Factory on this VPS" />
    <template v-if="factory">
      <p class="text-sm text-muted">Factory uses the same VPS and a persistent local Git checkout. It needs systemd, Linux loop/mount support, 7 GiB free disk and 2 GiB available RAM with capacity reserved for the Server. The released Node and workspace image are verified and paired automatically after Owner claim.</p>
      <UCheckbox v-model="trust" label="I accept Docker’s shared-kernel boundary for code and users I trust." />
    </template>
    <pre v-if="valid && (!factory || trust)" class="select-all overflow-x-auto rounded-lg border border-default p-4 text-xs leading-6">{{ command }}</pre>
    <p v-else class="text-sm text-muted">Enter a domain and email, and acknowledge the Factory boundary if enabled, to show the install command.</p>
    <p class="text-sm text-muted">Run the command on the VPS, then open its private Owner claim link and set a password. Existing Servers can use <code>sudo llll factory enable --trust-shared-kernel</code>. Remote Compute Nodes remain available in advanced setup.</p>
    <UButton to="https://github.com/inchidev/llll/blob/main/docs/vps-installer.md" label="VPS operator guide" color="neutral" variant="outline" external />
  </section>
</template>

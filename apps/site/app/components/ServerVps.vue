<script setup lang="ts">
// Example values stay placeholders: a prefilled example.com command is easy to copy by mistake.
const domain = ref(''), email = ref(''), factory = ref(false), trust = ref(false), copied = ref(false)
const valid = computed(() => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain.value) && /^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/iu.test(email.value))
const command = computed(() => [
  'curl -fsSL https://llll.gg/install.sh | sudo env',
  `  LLLL_DOMAIN='${domain.value}'`,
  `  LLLL_ADMIN_EMAIL='${email.value}'`,
  ...(factory.value ? ['  LLLL_FACTORY=true LLLL_SHARED_KERNEL_TRUSTED=1'] : []),
  '  bash',
].join(" \\\n"))
async function copyCommand() {
  await navigator.clipboard.writeText(command.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>
<template>
  <section class="space-y-5">
    <h2 class="text-2xl font-semibold">Install on your VPS</h2>
    <p class="text-sm leading-6 text-muted">You need a Debian or Ubuntu amd64 VPS and a domain pointed at it. The installer verifies the release, sets up Docker Compose and HTTPS, and starts your Server.</p>
    <UFormField label="Server domain" help="Point this domain’s DNS at the VPS before you run the command."><UInput v-model="domain" placeholder="chat.example.com" autocomplete="off" class="w-full" /></UFormField>
    <UFormField label="Owner email"><UInput v-model="email" type="email" placeholder="you@example.com" autocomplete="email" class="w-full" /></UFormField>
    <UCheckbox v-model="factory" label="Let agents run code on this VPS" description="Adds a compute node: agents get an isolated Task workspace with your project’s repository." />
    <template v-if="factory">
      <p class="text-sm leading-6 text-muted">Needs systemd, Linux loop/mount support, 17 GiB of free disk and 2 GiB of available RAM beyond what the Server uses. Each new Task workspace gets 10 GiB of disk. The node pairs itself after you claim the Server.</p>
      <UCheckbox v-model="trust" label="I trust the code and people using this VPS." description="Task workspaces run in Docker, which shares the host’s kernel. Use a separate machine for untrusted code." />
    </template>
    <div v-if="valid && (!factory || trust)" class="relative">
      <pre class="select-all overflow-x-auto rounded-lg border border-default p-4 pe-24 text-xs leading-6">{{ command }}</pre>
      <UButton :label="copied ? 'Copied' : 'Copy'" :icon="copied ? 'i-ph-check' : 'i-ph-copy'" size="xs" color="neutral" variant="outline" class="absolute end-3 top-3" @click="copyCommand" />
    </div>
    <p v-else class="text-sm text-muted">{{ factory && !trust && valid ? 'Confirm the compute node note to show the install command.' : 'Enter your domain and email to show the install command.' }}</p>
    <p class="text-sm leading-6 text-muted">Run the command on the VPS as root. It prints a private link where you choose the Owner password. Already running a Server? Add a compute node later with <code>sudo llll compute enable --trust-shared-kernel</code>.</p>
    <UButton to="https://github.com/inchidev/llll/blob/main/docs/vps-installer.md" label="VPS operator guide" color="neutral" variant="outline" external />
  </section>
</template>

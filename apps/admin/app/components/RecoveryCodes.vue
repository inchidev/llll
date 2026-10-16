<script setup lang="ts">
const props = defineProps<{ codes: string[] }>()
const emit = defineEmits<{ saved: [] }>()
const saved = ref(false)

function download() {
  const contents = `L4 Admin recovery codes\nAdmin: ${window.location.origin}\n\n${props.codes.join('\n')}\n\nEach code works once with your Admin email to reset the password. Keep these codes private and separate from this device.\n`
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'llll-admin-recovery-codes.txt'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <section class="space-y-5 rounded-lg border border-default bg-default p-5">
    <div>
      <h2 class="text-lg font-semibold text-highlighted">Save your recovery codes</h2>
      <p class="mt-1 text-sm text-muted">Each code resets your Admin password once. These codes are shown only now. Store them in your password manager or print them.</p>
    </div>
    <ul class="space-y-1 rounded-md bg-elevated p-3 font-mono text-xs sm:text-sm select-all">
      <li v-for="code in codes" :key="code">{{ code }}</li>
    </ul>
    <UButton label="Download codes" color="neutral" variant="outline" icon="i-ph-download-simple" @click="download" />
    <UCheckbox v-model="saved" label="I saved these codes somewhere safe" />
    <UButton label="Continue" :disabled="!saved" @click="emit('saved')" />
  </section>
</template>

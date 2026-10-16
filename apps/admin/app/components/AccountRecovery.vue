<script setup lang="ts">
const password = ref('')
const codes = ref<string[]>([])
const busy = ref(false)
const error = ref('')
const { data, refresh } = await useFetch<{ remaining: number }>('/api/admin/recovery', { server: false })

async function generate() {
  busy.value = true
  error.value = ''
  try {
    const result = await adminFetch<{ codes: string[] }>('/api/admin/recovery', { method: 'POST', body: { password: password.value } })
    codes.value = result.codes
    password.value = ''
    await refresh()
  }
  catch (cause) {
    error.value = failureMessage(cause)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <RecoveryCodes v-if="codes.length" :codes="codes" @saved="codes = []" />
  <section v-else class="space-y-4 rounded-lg border border-default p-5">
    <div>
      <h2 class="font-semibold text-highlighted">Account recovery</h2>
      <p class="mt-1 text-sm text-muted">{{ data?.remaining ?? 0 }} unused recovery codes. Reset your password on this Admin with your email and one code, even if llll.gg is unavailable.</p>
      <p class="mt-1 text-sm text-muted">Generating a new set invalidates all previous codes.</p>
    </div>
    <UAlert v-if="error" color="error" :title="error" />
    <form class="flex flex-wrap items-end gap-3" @submit.prevent="generate">
      <UFormField label="Current password">
        <UInput v-model="password" type="password" autocomplete="current-password" />
      </UFormField>
      <UButton type="submit" label="Generate new codes" :loading="busy" :disabled="!password" />
    </form>
  </section>
</template>

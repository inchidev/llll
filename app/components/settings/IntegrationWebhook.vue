<script setup lang="ts">
defineProps<{ url: string }>()
defineEmits<{ copy: [url: string] }>()
</script>

<template>
  <UFormField label="Address for the service">
    <div class="flex min-w-0 items-center gap-2">
      <code class="min-w-0 flex-1 break-all rounded bg-elevated px-2 py-1 text-xs">{{ url }}</code>
      <UButton label="Copy" color="neutral" variant="outline" @click="$emit('copy', url)" />
    </div>
  </UFormField>
</template>

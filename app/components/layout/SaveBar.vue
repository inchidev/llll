<script setup lang="ts">
/** Sticky "unsaved changes" bar, so edits deep in a long pane are never lost or hidden. */
defineProps<{
  dirty: boolean
  saving?: boolean
  disabled?: boolean
}>()
defineEmits<{ save: [], reset: [] }>()
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="translate-y-3 opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="translate-y-3 opacity-0"
  >
    <div
      v-if="dirty"
      class="l4-save-bar sticky bottom-4 z-10 mt-6 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 rounded-md border border-default bg-elevated p-3 shadow-sm sm:flex sm:px-4 sm:py-2.5"
      role="status"
    >
      <p class="col-span-2 min-w-0 flex-1 text-sm text-default">You have unsaved changes</p>
      <UButton color="neutral" variant="ghost" size="sm" label="Reset" class="justify-self-end" :disabled="saving" @click="$emit('reset')" />
      <UButton size="sm" label="Save changes" :loading="saving" :disabled="disabled" @click="$emit('save')" />
    </div>
  </Transition>
</template>

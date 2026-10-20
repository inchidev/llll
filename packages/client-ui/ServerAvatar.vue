<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
const props = defineProps<{ name: string; iconUrl?: string | null }>()
const failed = ref(false)
watch(() => props.iconUrl, () => { failed.value = false })
const initials = computed(() => props.name.trim().split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase() || 'L')
const retry = () => { failed.value = false }
onMounted(() => { window.addEventListener('online', retry); window.addEventListener('focus', retry) })
onUnmounted(() => { window.removeEventListener('online', retry); window.removeEventListener('focus', retry) })
</script>

<template>
  <span aria-hidden="true" class="flex shrink-0 items-center justify-center overflow-hidden text-sm font-semibold">
    <img v-if="iconUrl && !failed" :src="iconUrl" alt="" crossorigin="anonymous" referrerpolicy="no-referrer" class="size-full object-cover" @error="failed = true">
    <span v-else>{{ initials }}</span>
  </span>
</template>

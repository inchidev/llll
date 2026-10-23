<script setup lang="ts">
import type { SidebarThreadDTO } from '~~/shared/types'
import { channelPath, type ChannelRef } from '~~/shared/paths'

defineProps<{ channel: ChannelRef; threads: SidebarThreadDTO[]; label: string }>()
const liveRoute = useRouter().currentRoute
const selectedThread = computed(() => String(liveRoute.value.params.threadId || ''))
const warm = useMessagePrefetch()
</script>

<template>
  <ul v-if="threads.length" class="ms-[17px] pb-0.5" :aria-label="`Threads in ${label}`">
    <li
      v-for="(thread, threadIndex) in threads"
      :key="thread.id"
      class="relative ps-3"
    >
      <!-- Connector: a curve into each thread, continuing down to the next one. -->
      <span class="pointer-events-none absolute start-0 top-0 h-1/2 w-2.5 rounded-es-md border-b border-s border-accented" aria-hidden="true" />
      <span v-if="threadIndex < threads.length - 1" class="pointer-events-none absolute bottom-0 start-0 top-1/2 border-s border-accented" aria-hidden="true" />
      <LayoutNavRow
        :to="channelPath(channel, thread.id)"
        :title="thread.title"
        :active="selectedThread === thread.id"
        :unread="thread.unread"
        dense
        @pointerenter="warm.intent(thread.id)"
        @pointerleave="warm.cancel()"
        @focus="warm.prefetch(thread.id)"
      >
        {{ thread.title }}
        <template #trailing>
          <UBadge
            v-if="thread.unread && selectedThread !== thread.id"
            color="primary"
            variant="solid"
            size="sm"
            :label="thread.unreadCount > 99 ? '99+' : String(thread.unreadCount)"
            class="min-w-5 justify-center"
          />
        </template>
      </LayoutNavRow>
    </li>
  </ul>
</template>

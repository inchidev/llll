<script setup lang="ts">
// The phone's Shortcut opens whatever the upload answers, so a refused upload lands here. Only a code comes from the address.
definePageMeta({ layout: 'auth' })

const PROBLEMS: Record<string, { title: string; detail: string }> = {
  unauthorized: { title: 'That link doesn’t work', detail: 'It is mistyped or turned off, or you have left its Space. Make a new link in Settings → Connections → Shortcut, and add the Shortcut again with it.' },
  length_required: { title: 'Nothing was shared', detail: 'In Photos, open a screen recording or a screenshot, tap Share, and choose L4.' },
  too_large: { title: 'That file is too large', detail: 'Trim the recording in Photos and share it again.' },
  unsupported_type: { title: 'That isn’t a recording', detail: 'A recording is MP4, MOV, WebM, PNG, JPEG, WebP or GIF.' },
  space_quota: { title: 'This Space is out of storage', detail: 'Nothing was lost. Free some space, or ask the Space’s admin about its limit.' },
  space_suspended: { title: 'This Space is suspended', detail: 'Nothing in it is lost. Contact the Server Owner.' },
  rate_limited: { title: 'Too many uploads', detail: 'Wait a little and share it again.' },
  forbidden: { title: 'Your Role can’t do this', detail: 'Ask an admin to let your Role add Tasks and attach files.' },
}
const route = useRoute()
const problem = computed(() => PROBLEMS[String(route.query.why)] ?? { title: 'The upload did not work', detail: 'Nothing was saved. Share it again in a moment.' })
useHead({ title: 'Recording not saved' })
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold text-highlighted">{{ problem.title }}</h1>
    <p class="text-sm text-muted">{{ problem.detail }}</p>
    <UButton to="/settings?section=shortcut" label="Open Connections" color="neutral" variant="outline" />
  </div>
</template>

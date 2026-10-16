<script setup lang="ts">
type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  remove: (widgetId: string) => void
}

const props = defineProps<{ siteKey: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const target = ref<HTMLElement | null>(null)
const widgetId = ref<string | null>(null)
const callbackName = `llllTurnstile${Math.random().toString(36).slice(2)}`

function api(): TurnstileApi | undefined {
  return (window as typeof window & { turnstile?: TurnstileApi }).turnstile
}

function render() {
  if (!target.value || widgetId.value || !api()) return
  widgetId.value = api()!.render(target.value, {
    sitekey: props.siteKey,
    action: 'signup',
    theme: 'auto',
    callback: (token: string) => emit('update:modelValue', token),
    'expired-callback': () => emit('update:modelValue', ''),
    'error-callback': () => emit('update:modelValue', ''),
  })
}

onMounted(() => {
  const scope = window as typeof window & Record<string, unknown>
  scope[callbackName] = render
  render()
})

onBeforeUnmount(() => {
  if (widgetId.value) api()?.remove(widgetId.value)
  ;(window as typeof window & Record<string, unknown>)[callbackName] = undefined
})

useHead({
  script: [{
    key: 'cloudflare-turnstile',
    src: `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${callbackName}`,
    async: true,
    defer: true,
  }],
})
</script>

<template>
  <div ref="target" />
</template>

<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'

/** Draws an avatar with the Avatars AI function, shows it, and hands back a file to save. */
const props = defineProps<{ serverId: string; name: string }>()
const emit = defineEmits<{ use: [file: File] }>()
const { api } = useApi()
const toast = useToast()
const functions = useQuery({ queryKey: computed(() => ['ai-function-availability', props.serverId]), queryFn: () => api<{ functions: { id: string; available: boolean; modelLabel?: string }[] }>(`/api/servers/${props.serverId}/ai-functions`) })
const avatarFunction = computed(() => functions.data.value?.functions.find(fn => fn.id === 'avatar.generate'))
const available = computed(() => avatarFunction.value?.available === true)
const open = ref(false), description = ref(''), l4Style = ref(true), busy = ref(false), image = ref('')
const references = ref<string[]>([])
const picker = ref<HTMLInputElement | null>(null)

/** References are shrunk in the browser so three of them stay well under the request limits. */
async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.88)
}
async function addReferences(files: FileList | null | undefined) {
  for (const file of [...files ?? []].filter(item => item.type.startsWith('image/')).slice(0, 3 - references.value.length)) {
    try { references.value.push(await shrink(file)) }
    catch { toast.add({ title: `${file.name} could not be read as an image`, color: 'error' }) }
  }
  if (picker.value) picker.value.value = ''
}
async function generate() {
  if (busy.value) return
  busy.value = true
  try {
    image.value = (await api<{ image: string }>(`/api/servers/${props.serverId}/avatars/generate`, { method: 'POST', body: {
      name: props.name || 'Agent', l4Style: l4Style.value,
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      ...(references.value.length ? { references: references.value } : {}),
    } })).image
  }
  catch (error) { toast.add({ title: 'No avatar was drawn', description: errorMessage(error), color: 'error' }) }
  finally { busy.value = false }
}
/**
 * Cuts away the flat backdrop the model was asked to draw: pixels connected to the edges
 * that stay close to the corner colour become transparent, so the character stands alone.
 */
async function cutOut(bytes: Uint8Array<ArrayBuffer>, type: string): Promise<File | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const { width, height } = canvas, pixels = context.getImageData(0, 0, width, height), data = pixels.data
    const at = (x: number, y: number) => (y * width + x) * 4
    const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
    const [r, g, b] = [0, 1, 2].map(channel => corners.reduce((sum, index) => sum + data[index + channel]!, 0) / 4)
    // A backdrop the model did not keep flat is left alone rather than eaten into.
    if (corners.some(index => Math.abs(data[index]! - r!) + Math.abs(data[index + 1]! - g!) + Math.abs(data[index + 2]! - b!) > 60)) return null
    const close = (index: number) => Math.abs(data[index]! - r!) + Math.abs(data[index + 1]! - g!) + Math.abs(data[index + 2]! - b!) <= 48
    const seen = new Uint8Array(width * height), stack: number[] = []
    for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x)
    for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1)
    while (stack.length) {
      const point = stack.pop()!
      if (seen[point] || !close(point * 4)) continue
      seen[point] = 1; data[point * 4 + 3] = 0
      const x = point % width
      if (x > 0) stack.push(point - 1)
      if (x < width - 1) stack.push(point + 1)
      if (point >= width) stack.push(point - width)
      if (point < width * (height - 1)) stack.push(point + width)
    }
    context.putImageData(pixels, 0, 0)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    return blob && blob.size <= 2 * 1024 * 1024 ? new File([blob], 'avatar.png', { type: 'image/png' }) : null
  } catch { return null }
}
/** The picture arrives as a data URL; the page policy forbids fetching data: URLs, so it is decoded here. */
async function use() {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(image.value)
  if (!match) { toast.add({ title: 'This picture could not be used', color: 'error' }); return }
  const type = match[1]!, bytes = Uint8Array.from(atob(match[2]!), char => char.charCodeAt(0))
  emit('use', await cutOut(bytes, type) ?? new File([bytes], `avatar.${type.split('/')[1] || 'png'}`, { type }))
  close()
}
function close() { open.value = false; image.value = ''; references.value = []; description.value = '' }
</script>

<template>
  <template v-if="available">
    <UButton size="sm" color="neutral" variant="outline" icon="i-ph-sparkle" label="Generate" @click="open = true" />
    <UModal v-model:open="open" title="Generate an avatar" :description="avatarFunction?.modelLabel ? `Drawn by ${avatarFunction.modelLabel}` : undefined" :dismissible="!busy" @after:leave="close">
      <template #body>
        <div class="space-y-4">
          <UTextarea v-model="description" :rows="2" autoresize placeholder="A red cactus wearing sunglasses" class="w-full" aria-label="Describe the avatar" />
          <div class="flex flex-wrap items-center gap-2">
            <div v-for="(reference, index) in references" :key="index" class="relative">
              <img :src="reference" alt="Reference image" class="size-14 rounded-md object-cover">
              <button type="button" class="absolute -end-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-elevated text-muted ring ring-default hover:text-highlighted" :aria-label="`Remove reference ${index + 1}`" @click="references.splice(index, 1)"><UIcon name="i-ph-x" class="size-3" /></button>
            </div>
            <UButton v-if="references.length < 3" size="sm" color="neutral" variant="ghost" icon="i-ph-image" :label="references.length ? 'Add reference' : 'Add references (up to 3)'" @click="picker?.click()" />
            <input ref="picker" type="file" accept="image/png,image/jpeg,image/webp" multiple class="hidden" @change="addReferences(($event.target as HTMLInputElement).files)">
          </div>
          <UCheckbox v-model="l4Style" label="L4 style" description="A toy-like character with a face, in black and white, shaped after the L4 logo." />
          <div v-if="image || busy" class="flex justify-center">
            <img v-if="image && !busy" :src="image" alt="Generated avatar preview" class="size-48 rounded-[28%] object-cover">
            <div v-else class="flex size-48 items-center justify-center rounded-[28%] bg-elevated"><UIcon name="i-ph-spinner-gap" class="size-8 animate-spin text-muted" /></div>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="busy" @click="open = false" />
          <UButton :color="image ? 'neutral' : 'primary'" :variant="image ? 'outline' : 'solid'" :label="image ? 'Try again' : 'Generate'" icon="i-ph-sparkle" :loading="busy" @click="generate" />
          <UButton v-if="image" label="Use this picture" icon="i-ph-check" :disabled="busy" @click="use" />
        </div>
      </template>
    </UModal>
  </template>
</template>

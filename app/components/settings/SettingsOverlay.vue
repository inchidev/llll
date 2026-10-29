<script setup lang="ts">
import { llllReleaseUrl } from '~~/shared/releases'
import { settingsEditorKey } from '../../composables/useSettingsEditor'
import { provide, shallowRef } from 'vue'

export type SettingsItem = {
  id: string
  label: string
  icon: string
  badge?: string
  /** Extra terms the search box should match, for settings people look for by another name. */
  keywords?: string[]
  /** Sub-sections (tabs inside the pane) that keep this item highlighted. */
  aliases?: string[]
}
export type SettingsGroup = { label?: string; items: SettingsItem[] }

const props = defineProps<{
  groups: SettingsGroup[]
  /** Shown above the nav — the account name or the server name. */
  title: string
  /** The section list depends on data that is still loading. */
  loading?: boolean
  editorPages?: boolean
}>()

const open = defineModel<boolean>('open', { default: false })
const section = defineModel<string>('section', { default: '' })

const appConfig = useAppConfig()
const { $pwa } = useNuxtApp()
const releaseUrl = computed(() => llllReleaseUrl(appConfig.version))
const isMobile = useIsMobile()
const detailBack = provideSettingsDetailBack()
const editorTarget = ref<HTMLElement | null>(null)
const activeEditor = shallowRef<symbol | null>(null)
const sectionRevision = ref(0)
if (props.editorPages) provide(settingsEditorKey, { target: editorTarget, active: activeEditor })

const query = ref('')
const searchActivated = ref(false)
const searchQuery = computed({ get: () => query.value, set: (value: string | number) => { if (searchActivated.value) query.value = String(value) } })
function activateSearch(event: Event) {
  if (event instanceof KeyboardEvent && ['Tab', 'Shift', 'Escape', 'Control', 'Alt', 'Meta'].includes(event.key)) return
  searchActivated.value = true
  if (event.target instanceof HTMLInputElement) event.target.readOnly = false
}
function guardSearchInput(event: Event) {
  if (!searchActivated.value && event.target instanceof HTMLInputElement) event.target.value = ''
}
/**
 * On mobile the two panes become two screens: pick a section, then read it.
 * A link that names a section (`?section=email`) opens that section directly.
 */
const route = useRoute()
const deepLinked = () => typeof route.query.section === 'string' && route.query.section.length > 0
const mobileView = ref<'nav' | 'detail'>(deepLinked() ? 'detail' : 'nav')

const filtered = computed<SettingsGroup[]>(() => {
  const term = query.value.trim().toLowerCase()
  if (!term) return props.groups
  return props.groups
    .map(group => ({
      label: group.label,
      items: group.items.filter(item => [item.label, ...(item.keywords ?? [])]
        .some(value => value.toLowerCase().includes(term))),
    }))
    .filter(group => group.items.length)
})

const visibleItems = computed(() => filtered.value.flatMap(group => group.items))
function isActive(item: SettingsItem) {
  return item.id === section.value || Boolean(item.aliases?.includes(section.value))
}

const activeLabel = computed(() => props.groups
  .flatMap(group => group.items)
  .find(isActive)?.label ?? '')

function select(id: string) {
  if (props.groups.flatMap(group => group.items).some(item => item.id === id && isActive(item))) sectionRevision.value++
  section.value = id
  query.value = ''
  searchActivated.value = false
  mobileView.value = 'detail'
}

/** Enter in the search box commits the only remaining match. */
function submitSearch() {
  const only = visibleItems.value[0]
  if (only && visibleItems.value.length === 1) select(only.id)
}

/** Up/Down walks the visible sections without leaving the keyboard. */
function step(delta: 1 | -1) {
  const items = visibleItems.value
  if (!items.length) return
  const index = items.findIndex(isActive)
  const next = items[Math.min(Math.max(index + delta, 0), items.length - 1)]
  if (next) section.value = next.id
}

function close() {
  open.value = false
}

watch(open, (value) => {
  if (!value) return
  void $pwa?.check()
  query.value = ''
  searchActivated.value = false
  mobileView.value = isMobile.value && !deepLinked() ? 'nav' : 'detail'
}, { immediate: true })

watch(isMobile, (value) => {
  if (!value) mobileView.value = 'detail'
})

const settingsSurface = ref<HTMLElement | null>(null)
function focusSettings(event: Event) {
  event.preventDefault()
  void nextTick(() => settingsSurface.value?.focus({ preventScroll: true }))
}
function onEscape(event: KeyboardEvent) {
  event.preventDefault()
  event.stopPropagation()
  if (detailBack.value) detailBack.value.go()
  else if (isMobile.value && mobileView.value === 'detail') mobileView.value = 'nav'
  else close()
}
</script>

<template>
  <UModal
    v-model:open="open"
    fullscreen
    :close="false"
    :dismissible="false"
    :content="{ onOpenAutoFocus: focusSettings, onEscapeKeyDown: onEscape }"
    :ui="{
      overlay: 'bg-muted dark:bg-black',
      content: 'divide-y-0 p-0 ring-0 shadow-none rounded-none bg-muted dark:bg-black inset-0',
    }"
  >
    <template #content>
      <ClientUpdateBanner />
      <div
        ref="settingsSurface"
        class="flex min-h-0 flex-1 pb-[var(--df-safe-area-bottom)] pt-[var(--df-safe-area-top)]"
        tabindex="-1"
        role="document"
        style="outline: none"
      >
        <div
          class="min-w-0 flex-1 justify-end bg-muted dark:bg-black md:flex md:min-w-[192px] md:flex-none md:border-e md:border-default"
          :class="isMobile && mobileView === 'detail' ? 'hidden' : 'flex'"
        >
          <aside class="flex w-full flex-col overflow-y-auto px-2 pb-6 pe-1.5 pt-6 *:shrink-0 md:w-[192px] md:py-[60px] lg:w-[218px]">
            <div class="flex items-center gap-1 px-1 pb-3 md:hidden">
              <h1 class="min-w-0 flex-1 truncate text-lg font-semibold text-highlighted">Settings</h1>
              <UButton icon="i-ph-x" color="neutral" variant="ghost" square aria-label="Close settings" @click="close" />
            </div>
            <p class="mb-2 truncate px-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">{{ title }}</p>

            <UInput
              v-model="searchQuery"
              type="search"
              :readonly="!searchActivated"
              data-form-type="other"
              data-bwignore
              name="settings-filter"
              data-1p-ignore
              data-lpignore="true"
              :spellcheck="false"
              icon="i-ph-magnifying-glass"
              placeholder="Search settings"
              autocomplete="off"
              size="sm"
              class="mb-2 px-0.5"
              :ui="{ root: 'w-full' }"
              aria-label="Search settings"
              @pointerdown="activateSearch"
              @keydown="activateSearch"
              @input="guardSearchInput"
              @keydown.enter.prevent="submitSearch"
              @keydown.down.prevent="step(1)"
              @keydown.up.prevent="step(-1)"
            />

            <LayoutSkeleton v-if="loading && !groups.some(group => group.items.length)" variant="nav" :rows="8" class="-mx-2" />
            <p v-else-if="!filtered.length" class="px-2.5 py-3 text-sm text-muted">
              Nothing matches “{{ query }}”.
            </p>

            <template v-for="(group, index) in filtered" :key="group.label ?? index">
              <USeparator v-if="index" class="my-3" />
              <p v-if="group.label" class="mb-1 px-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">{{ group.label }}</p>
              <nav class="space-y-0.5">
                <button
                  v-for="item in group.items"
                  :key="item.id"
                  type="button"
                  class="flex h-11 w-full items-center gap-2 rounded-md px-2.5 text-start text-sm md:h-8"
                  :class="isActive(item)
                    ? 'bg-accented text-highlighted'
                    : 'text-muted hover:bg-elevated hover:text-default'"
                  :aria-current="isActive(item) ? 'page' : undefined"
                  @click="select(item.id)"
                >
                  <UIcon :name="item.icon" class="size-[18px] shrink-0" />
                  <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
                  <UBadge v-if="item.badge" :label="item.badge" color="warning" variant="subtle" size="sm" />
                  <UIcon v-if="isMobile" name="i-ph-caret-right" class="size-4 shrink-0 text-dimmed" />
                </button>
              </nav>
            </template>

            <div class="mt-auto pt-8">
              <slot name="footer" />
              <a
                :href="releaseUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-block px-2.5 pt-4 text-[11px] text-dimmed hover:text-muted hover:underline"
              >L4 v{{ appConfig.version }}</a>
            </div>
          </aside>
        </div>

        <div
          class="min-w-0 flex-1 bg-default dark:bg-black md:flex md:flex-[1_1_800px]"
          :class="isMobile && mobileView === 'nav' ? 'hidden' : 'flex'"
        >
          <!-- The whole pane scrolls, so the wheel works beside the content; only the content keeps its reading width. -->
          <div class="l4-settings-pane min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] px-4 pb-24 pt-4 sm:px-10 md:py-[60px] md:[&>*]:max-w-[660px]">
            <div class="mb-4 flex items-center gap-1 md:hidden">
              <UButton
                icon="i-ph-arrow-left"
                color="neutral"
                variant="ghost"
                square
                :aria-label="detailBack ? `Back to ${detailBack.label}` : 'Back to settings list'"
                @click="detailBack ? detailBack.go() : mobileView = 'nav'"
              />
              <span class="min-w-0 flex-1 truncate text-sm text-muted">{{ activeLabel }}</span>
              <UButton icon="i-ph-x" color="neutral" variant="ghost" square aria-label="Close settings" @click="close" />
            </div>
            <div v-show="!activeEditor" :key="sectionRevision"><slot /></div>
            <div v-show="Boolean(activeEditor)" ref="editorTarget" />
          </div>
          <div class="hidden w-14 shrink-0 pe-2 pt-[60px] md:block sm:w-16 sm:pe-3">
            <button
              type="button"
              class="mx-auto flex size-9 items-center justify-center rounded-full border-2 border-muted text-muted transition-colors hover:border-default hover:text-highlighted"
              aria-label="Close settings"
              @click="close"
            >
              <UIcon name="i-ph-x" class="size-5" />
            </button>
            <p class="mt-1.5 text-center text-[13px] font-bold tracking-wide text-muted">ESC</p>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>

import type { InjectionKey, Ref, ShallowRef } from 'vue'

export type SettingsEditorContext = {
  target: Ref<HTMLElement | null>
  active: ShallowRef<symbol | null>
}
export const settingsEditorKey: InjectionKey<SettingsEditorContext> = Symbol('settings-editor')

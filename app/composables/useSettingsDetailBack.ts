import type { InjectionKey, ShallowRef } from 'vue'

export type SettingsDetailBack = { label: string, go: () => void }

/**
 * On mobile the settings overlay draws one back button. A detail pane inside a
 * section (a role, a mailbox) hands it the step back to its list, so the header
 * does not show a second back button of its own.
 */
export const settingsDetailBackKey: InjectionKey<ShallowRef<SettingsDetailBack | null>> = Symbol('settings-detail-back')

export function provideSettingsDetailBack() {
  const back = shallowRef<SettingsDetailBack | null>(null)
  provide(settingsDetailBackKey, back)
  return back
}

import type { InjectionKey, ShallowRef } from 'vue'

export const documentCreateGuardKey: InjectionKey<ShallowRef<(() => Promise<boolean>) | null>> = Symbol('document-create-guard')
export function provideDocumentCreateGuard() {
  const guard = shallowRef<(() => Promise<boolean>) | null>(null)
  provide(documentCreateGuardKey, guard)
  return guard
}
export function useDocumentCreateGuard(save: () => Promise<boolean>) {
  const guard = inject(documentCreateGuardKey, null)
  if (guard) guard.value = save
  onBeforeUnmount(() => { if (guard?.value === save) guard.value = null })
}

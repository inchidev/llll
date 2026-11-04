/** A phone has no room for the app's Server rail beside a page, so it joins the navigation drawer. Sign-in has no drawer. */
export default defineNuxtPlugin(() => {
  const setRail = window.__LLLL_NATIVE_RAIL__
  if (!setRail) return
  const ui = useUiStore()
  const session = useSessionStore()
  watch(() => !session.user || ui.mobilePane === 'channels', (visible) => { void setRail(visible).catch(() => undefined) }, { immediate: true })
})

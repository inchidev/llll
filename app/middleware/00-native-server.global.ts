export default defineNuxtRouteMiddleware((to) => {
  if (!import.meta.client) return
  const { native, activeOrigin, initialize } = useClientServers()
  if (!native) return

  initialize()
  if (!activeOrigin.value && !['/connections', '/deploy', '/servers', '/consent'].includes(to.path)) return navigateTo('/connections')
})

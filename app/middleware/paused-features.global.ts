import { pausedSections } from '~~/shared/features'
import { serverNavigationSection } from '~~/shared/server-navigation'

/** Paused areas keep their data; old links and bookmarks land on the Server's start page. */
export default defineNuxtRouteMiddleware((to) => {
  const section = serverNavigationSection(to.path)
  if (section && pausedSections.has(section)) return navigateTo('/', { replace: true })
})

import { takeLinkBack, useServerLinks } from '~/composables/useServerLinks'

/** Read before the router can replace the address; the offer waits for the page to be up. */
export default defineNuxtPlugin({
  name: 'server-link', order: -100,
  setup(nuxt) {
    const from = takeLinkBack()
    const servers = useServerLinks()
    servers.load()
    if (from) nuxt.hook('app:mounted', () => { void servers.offer(from) })
    if (servers.links.value.length) nuxt.hook('app:mounted', () => { void servers.refresh() })
  },
})

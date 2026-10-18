import { communityRailIcons } from '../../packages/client-ui/icons'

export default defineNuxtConfig({
  compatibilityDate: '2026-10-16', ssr: true, devtools: { enabled: false },
  modules: ['@nuxt/ui'], css: ['~/assets/css/main.css'],
  colorMode: { preference: 'dark', fallback: 'dark' },
  icon: { clientBundle: { scan: true, icons: communityRailIcons }, serverBundle: { collections: ['ph'] } },
  nitro: { preset: 'static', prerender: { routes: ['/', '/open', '/servers', '/deploy', '/privacy', '/terms', '/docs'], crawlLinks: false } },
  app: { head: { htmlAttrs: { lang: 'en' }, meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }, { name: 'theme-color', content: '#090909' }], link: [{rel:'icon', href:'/favicon.svg'}, {rel:'manifest', href:'/site.webmanifest'}] } },
})

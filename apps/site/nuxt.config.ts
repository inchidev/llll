import { communityRailIcons } from '../../packages/client-ui/icons'

export default defineNuxtConfig({
  ...(process.env.NODE_ENV === 'development' && process.env.LLLL_DEV_SHELL_API_ORIGIN ? {
    buildDir: '../../.deployment/dev-stack/nuxt-shell',
  } : {}),
  compatibilityDate: '2026-10-16', ssr: true, devtools: { enabled: false },
  modules: ['@nuxt/ui'], css: ['~/assets/css/main.css'],
  runtimeConfig: { public: { docsRef: process.env.LLLL_DOCS_REF || process.env.WORKERS_CI_COMMIT_SHA || 'main' } },
  colorMode: { preference: 'dark', fallback: 'dark' },
  icon: { clientBundle: { scan: true, icons: communityRailIcons }, serverBundle: { collections: ['ph'] } },
  nitro: {
    preset: 'static',
    prerender: { routes: ['/', '/servers', '/create', '/privacy', '/terms', '/docs'], crawlLinks: false },
    ...(process.env.NODE_ENV === 'development' && process.env.LLLL_DEV_SHELL_API_ORIGIN ? {
      devProxy: { '/api': { target: `${process.env.LLLL_DEV_SHELL_API_ORIGIN}/api`, changeOrigin: false } },
    } : {}),
  },
  app: { head: { htmlAttrs: { lang: 'en' }, meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }, { name: 'theme-color', content: '#090909' }], link: [{rel:'icon', href:'/favicon.svg'}, {rel:'manifest', href:'/site.webmanifest'}] } },
})

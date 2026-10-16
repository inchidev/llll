export default defineNuxtConfig({
  compatibilityDate: '2026-09-28',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  modules: ['@nuxt/ui'],
  colorMode: {
    preference: 'dark',
    fallback: 'dark',
  },
  icon: {
    serverBundle: {
      collections: ['ph'],
    },
  },
  app: {
    head: {
      title: 'L4 Admin',
      meta: [{ name: 'robots', content: 'noindex' }],
    },
  },
  nitro: {
    preset: 'cloudflare-module',
    entry: process.env.NODE_ENV === 'development' ? undefined : './admin-entry.ts',
    cloudflare: {
      nodeCompat: true,
    },
    typescript: {
      tsConfig: {
        compilerOptions: {
          types: ['@cloudflare/workers-types'],
        },
      },
    },
  },
  typescript: {
    tsConfig: {
      compilerOptions: {
        types: ['@cloudflare/workers-types'],
      },
    },
  },
})

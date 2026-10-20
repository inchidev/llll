import { readFile } from 'node:fs/promises'
import { llllNitroPlugins, llllNodeAliases } from './nitro.runtime.mjs'
import { communityRailIcons } from './packages/client-ui/icons'

const devPublicHost = process.env.LLLL_DEV_HOST?.trim() || ''
const requestedClientMode = process.env.LLLL_CLIENT_MODE
const clientMode = requestedClientMode === 'native' || requestedClientMode === 'extension'
  ? requestedClientMode
  : 'web'
const bundledClient = clientMode !== 'web'
const staticWebClient = process.env.LLLL_STATIC_CLIENT === 'true'
const devProxyOrigin = process.env.LLLL_DEV_PROXY_ORIGIN
  ? new URL(process.env.LLLL_DEV_PROXY_ORIGIN).origin
  : null
const remoteFrontend = Boolean(devProxyOrigin && process.env.NODE_ENV === 'development')
const stackFrontend = process.env.LLLL_DEV_STACK === 'true' && process.env.NODE_ENV === 'development'
const rawSqlPlugin = {
  name: 'llll-raw-sql',
  async load(id: string) {
    if (!id.endsWith('.sql?raw')) return null
    const sql = await readFile(id.slice(0, -4), 'utf8')
    return `export default ${JSON.stringify(sql)}`
  },
}

export default defineNuxtConfig({
  ...(stackFrontend ? {
    buildDir: '.deployment/dev-stack/nuxt-client',
    serverDir: '.deployment/dev-stack/frontend-server',
  } : {}),
  compatibilityDate: '2026-10-16',
  ssr: false,
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  modules: ['@nuxt/ui', '@pinia/nuxt', '@vueuse/nuxt', '@nuxt/eslint'],
  colorMode: {
    preference: 'dark',
    fallback: 'dark',
  },
  icon: {
    clientBundle: { icons: communityRailIcons },
    serverBundle: {
      collections: ['ph'],
    },
    ...((bundledClient || staticWebClient)
      ? {
          clientBundle: {
            icons: communityRailIcons,
            scan: true,
          },
        }
      : {}),
  },
  runtimeConfig: {
    public: {
      clientMode,
      devRemoteOrigin: remoteFrontend && devProxyOrigin ? devProxyOrigin : '',
    },
  },
  nitro: bundledClient || staticWebClient ? {
    preset: 'static',
    ...(staticWebClient ? { output: { dir: '.client-output' } } : {}),
    rollupConfig: {
      plugins: [rawSqlPlugin],
    },
  } : {
    preset: remoteFrontend ? 'node-server' : 'cloudflare-module',
    entry: process.env.NODE_ENV === 'development' ? undefined : './cloudflare-entry.ts',
    alias: llllNodeAliases,
    rollupConfig: {
      plugins: [rawSqlPlugin, ...(stackFrontend ? [] : llllNitroPlugins())],
    },
    errorHandler: './server/error',
    ...(remoteFrontend
      ? {}
      : {
          cloudflare: {
            nodeCompat: true,
            deployConfig: false,
            dev: {
              configPath: 'wrangler.dev.jsonc',
            },
          },
        }),
    typescript: {
      tsConfig: {
        compilerOptions: {
          types: ['@cloudflare/workers-types'],
        },
      },
    },
    routeRules: {
      '/**': {
        headers: {
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
        },
      },
    },
    devProxy: devProxyOrigin
      ? {
          '/api': {
            target: `${devProxyOrigin}/api`,
            changeOrigin: true,
            cookieDomainRewrite: '',
            headers: { origin: devProxyOrigin },
          },
        }
      : undefined,
  },
  vite: {
    optimizeDeps: {
      include: ['@cloudflare/realtimekit'],
    },
    server: {
      ...(stackFrontend ? {
        origin: process.env.LLLL_DEV_PROXY_ORIGIN,
        ws: { clientPort: Number(new URL(process.env.LLLL_DEV_PROXY_ORIGIN!).port) },
      } : {}),
      allowedHosts: [
        'localhost',
        '127.0.0.1',
        ...(devPublicHost
          ? [devPublicHost, `.${devPublicHost.split('.').slice(1).join('.')}`]
          : []),
      ],
      ...(devPublicHost
        ? {
            ws: {
              protocol: 'wss',
              host: devPublicHost,
              clientPort: 443,
            },
          }
        : {}),
    },
  },
  router: {
    options: {
      hashMode: clientMode === 'extension',
    },
  },
  app: {
    head: {
      title: 'L4',
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'color-scheme', content: 'dark light' },
        { name: 'theme-color', content: '#000000', media: '(prefers-color-scheme: dark)' },
        { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' },
        { name: 'description', content: 'Chat that lives on your Cloudflare account.' },
        { name: 'application-name', content: 'L4' },
        { name: 'apple-mobile-web-app-title', content: 'L4' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' },
        { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16x16.png' },
        { rel: 'shortcut icon', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/site.webmanifest' },
      ],
    },
  },
  typescript: {
    strict: true,
    typeCheck: false,
    tsConfig: {
      compilerOptions: {
        types: ['@cloudflare/workers-types'],
      },
      include: ['../types/**/*.d.ts', '../workers/**/*.ts', '../shared/**/*.ts'],
    },
  },
})

import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

export default defineNuxtPlugin((nuxtApp) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: 4,
        retryDelay: attempt => Math.min(250 * 2 ** attempt, 2000),
        refetchOnWindowFocus: true,
      },
    },
  })
  nuxtApp.vueApp.use(VueQueryPlugin, { queryClient })
  return { provide: { queryClient } }
})

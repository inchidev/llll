import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { L4ComputeOverview } from '~~/shared/l4-compute'

/** L4 Compute in Settings → Compute: what llll.gg says about this Server's link, and the connect and disconnect steps. */
export function useL4Compute() {
  const { api } = useApi(), toast = useToast(), cache = useQueryClient()
  const overview = useQuery({ queryKey: ['l4-compute'], queryFn: () => api<L4ComputeOverview>('/api/compute/cloud'), refetchOnWindowFocus: true, refetchInterval: 60000 })
  const busy = ref(false)
  /** Add L4 Compute: the browser goes to llll.gg and comes back to this Server's callback, which returns it to Settings → Compute. */
  async function connect() {
    if (busy.value) return
    busy.value = true
    try {
      const { url } = await api<{ url: string }>('/api/compute/cloud/connect', { method: 'POST' })
      if (import.meta.client) window.location.href = url
    } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
    finally { busy.value = false }
  }
  async function disconnect() {
    if (busy.value) return
    busy.value = true
    try {
      await api('/api/compute/cloud', { method: 'DELETE' })
      toast.add({ title: 'L4 Compute disconnected', color: 'success' })
      await Promise.all([overview.refetch(), cache.invalidateQueries({ queryKey: ['compute-nodes'] }), cache.invalidateQueries({ queryKey: ['factory-setup'] })])
    } catch (error) { toast.add({ title: errorMessage(error), color: 'error' }) }
    finally { busy.value = false }
  }
  return { overview, busy, connect, disconnect }
}

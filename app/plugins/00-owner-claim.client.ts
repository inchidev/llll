import { readDeploymentClaim } from '~~/shared/deploy-handoff'

/** Capture the fragment before embedded navigation or hydration can replace the route. */
export default defineNuxtPlugin({
  name: 'owner-claim', order: -100,
  setup() {
    const token = readDeploymentClaim(location.hash)
    const claim = useState('owner-claim', () => '')
    if (token && location.pathname === '/setup') {
      claim.value = token
      try { sessionStorage.setItem('df:owner-setup-token', token) } catch { /* The in-memory claim still works. */ }
      history.replaceState(history.state, '', location.pathname + location.search)
    }
  },
})

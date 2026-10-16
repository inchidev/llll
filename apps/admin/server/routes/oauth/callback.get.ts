import { parseAdminRelayState } from '@llll/admin-core'
import { finishReconnect } from '../../utils/credential'
import { adminEnv, errorMessage } from '../../utils/http'
import { currentOwner } from '../../utils/session'

/** llll.gg forwards Cloudflare's code here; the Admin redeems it with its own verifier. */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const back = (message: string) => sendRedirect(event, `/?cloudflare=${encodeURIComponent(message)}`)
  if (!await currentOwner(event)) return back('Sign in to the Admin, then reconnect Cloudflare again')
  if (typeof query.error === 'string') return back(typeof query.error_description === 'string' ? query.error_description : query.error)
  const state = typeof query.state === 'string' ? parseAdminRelayState(query.state) : null
  const code = typeof query.code === 'string' ? query.code : ''
  if (!state || !code || state.hostname !== getRequestURL(event).hostname) return back('This Cloudflare connection link is invalid')
  try {
    await finishReconnect(adminEnv(event), { code, nonce: state.nonce })
    return back('connected')
  }
  catch (error) {
    return back(errorMessage(error, 'Cloudflare did not complete the connection'))
  }
})

import { pkceChallenge, randomCode } from '~~/shared/cloudflare-oauth'

/** The iframe owns the verifier and receives its session directly from its server. */
export function useServerPopup() {
  const connections = useServers()
  async function signIn() {
    const popup = window.open(
      'about:blank',
      'llll-server-login',
      'popup,width=520,height=720',
    )
    if (!popup)
      throw new Error('Allow a sign-in window, or open this server directly')
    const verifier = randomCode()
    const state = randomCode()
    const redirect = `${location.origin}/connections`
    const target = new URL('/api/auth/connection/authorize', location.origin)
    target.search = new URLSearchParams({
      redirect_uri: redirect,
      state,
      code_challenge: await pkceChallenge(verifier),
    }).toString()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        popup.close()
        reject(new Error('Sign-in window expired. Try again.'))
      }, 300000)
      const cleanup = () => {
        clearTimeout(timer)
        window.removeEventListener('message', receive)
      }
      const receive = async (event: MessageEvent) => {
        if (
          event.origin !== location.origin ||
          event.source !== popup ||
          event.data?.type !== 'llll-local-login' ||
          event.data.state !== state ||
          !/^[a-f0-9]{64}$/.test(event.data.code)
        )
          return
        cleanup()
        try {
          await connections.request(
            location.origin,
            '/api/auth/connection/exchange',
            {
              method: 'POST',
              body: {
                code: event.data.code,
                code_verifier: verifier,
                redirect_uri: redirect,
              },
            },
          )
          await connections.refresh(location.origin)
          popup.close()
          resolve()
        } catch (cause) {
          popup.close()
          reject(cause)
        }
      }
      window.addEventListener('message', receive)
      popup.location.replace(target.toString())
    })
  }
  return { signIn }
}

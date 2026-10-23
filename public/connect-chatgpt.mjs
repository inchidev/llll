// L4 browser sign-in helper. Node 24+, no packages or credential files.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
const [serverOrigin, authorization] = process.argv.slice(2)
const origin = new URL(serverOrigin)
if (origin.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('Use an HTTPS Server URL')
const auth = new URL(authorization)
if (auth.origin !== 'https://auth.openai.com' || auth.pathname !== '/api/accounts/authorize') throw new Error('Invalid ChatGPT authorization URL')
const redirect = new URL(auth.searchParams.get('redirect_uri'))
if (redirect.href !== 'http://127.0.0.1:1455/auth/callback') throw new Error('Invalid loopback callback')
const state = auth.searchParams.get('state')
const listener = createServer(async (req, res) => {
  const callback = new URL(req.url, redirect.origin)
  if (req.method !== 'GET' || callback.pathname !== redirect.pathname || callback.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid callback'); return }
  try {
    const response = await fetch(new URL('/api/agent-auth/complete', origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callbackUrl: callback.href }), signal: AbortSignal.timeout(60000), redirect: 'error' })
    if (!response.ok) throw new Error('Sign-in failed. Return to L4 and connect again.')
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end('<h1>ChatGPT connected</h1><p>Return to L4. You can close this tab.</p><script>history.replaceState(null,"","/auth/callback")</script>')
    console.log('ChatGPT connected. Return to L4 settings.')
  } catch { res.writeHead(400).end('Sign-in failed. Return to L4 and connect again.'); console.error('Sign-in failed.') }
  finally { listener.close(); clearTimeout(timeout) }
})
listener.on('error', () => { clearTimeout(timeout); console.error('Cannot open port 1455. Close any other sign-in helper and try again.'); process.exitCode = 1 })
const timeout = setTimeout(() => { console.error('Sign-in expired. Connect again in L4.'); listener.close() }, 600000)
listener.listen(1455, '127.0.0.1', () => {
  console.log('Continue with ChatGPT in the browser. Return to L4 when finished.')
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  const browser = spawn(command, [auth.href], { stdio: 'ignore' })
  browser.on('error', () => console.log(`Open this URL in your browser: ${auth.href}`))
})

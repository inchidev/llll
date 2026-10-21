import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const docker = promisify(execFile)
const secret = process.env.LLLL_RUNNER_TOKEN
const serverId = process.env.LLLL_SERVER_ID
const network = process.env.LLLL_AGENT_NETWORK
const image = process.env.LLLL_AGENT_IMAGE
if (!secret || secret.length < 32 || !serverId || !network || !image) throw new Error('Configure Runner token, Server ID, private Docker network and pinned Agent image')
const auth = Buffer.from(`Bearer ${secret}`)
async function inspect(name) {
  try { return JSON.parse((await docker('docker', ['inspect', name], { maxBuffer: 128000 })).stdout)[0] }
  catch (error) { if (error.code === 1) return null; throw error }
}
const starting = new Map()
async function start(id, token) {
  const name = `llll-agent-${id}`
  const volumeName = `${name}-data`
  let container = await inspect(name)
  if (container && (container.Config.Labels['llll.server'] !== serverId || container.Config.Labels['llll.run'] !== id)) throw new Error('Foreign container')
  if (!container) {
    // Reject a pre-existing volume owned by anything other than this Run.
    let volume
    try { volume = JSON.parse((await docker('docker', ['volume', 'inspect', volumeName])).stdout)[0] }
    catch (error) { if (error.code !== 1) throw error }
    if (volume && (volume.Labels?.['llll.server'] !== serverId || volume.Labels?.['llll.run'] !== id)) throw new Error('Foreign volume')
    if (!volume) await docker('docker', ['volume', 'create', '--label', `llll.server=${serverId}`, '--label', `llll.run=${id}`, volumeName])
    await docker('docker', ['run', '-d', '--name', name, '--label', `llll.server=${serverId}`, '--label', `llll.run=${id}`,
      '--network', network, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '1g', '--cpus', '1',
      '--env', `LLLL_RUN_TOKEN=${token}`, '--mount', `type=volume,source=${volumeName},target=/data`, image], { timeout: 60000 })
  } else if (!container.State.Running) await docker('docker', ['start', name], { timeout: 60000 })
  const url = `http://${name}:8080`
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) })).ok) return url }
    catch { /* The process may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Agent startup timed out')
}
createServer(async (request, response) => {
  const supplied = Buffer.from(request.headers.authorization || '')
  if (supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) { response.writeHead(401).end(); return }
  const url = new URL(request.url, 'http://runner')
  const match = url.pathname.match(/^\/runs\/([0-9a-f-]{36})\/(run|session|lifecycle|health)$/u)
  if (!match || !['GET', 'POST', 'DELETE'].includes(request.method)) { response.writeHead(404).end(); return }
  const id = match[1]
  const token = request.headers['x-run-capability']
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/u.test(token)) { response.writeHead(400).end(); return }
  try {
    if (match[2] === 'lifecycle') {
      if (request.method !== 'DELETE') { response.writeHead(405).end(); return }
      // Never start compute while stopping it. Only remove this Server's labelled resources.
      await starting.get(id)
      const name = `llll-agent-${id}`
      const container = await inspect(name)
      if (container) {
        if (container.Config.Labels['llll.server'] !== serverId || container.Config.Labels['llll.run'] !== id) throw new Error('Foreign container')
        await docker('docker', ['rm', '-f', name], { timeout: 30000 })
      }
      let volume
      try { volume = JSON.parse((await docker('docker', ['volume', 'inspect', `${name}-data`])).stdout)[0] }
      catch (error) { if (error.code !== 1) throw error }
      if (volume) {
        if (volume.Labels?.['llll.server'] !== serverId || volume.Labels?.['llll.run'] !== id) throw new Error('Foreign volume')
        await docker('docker', ['volume', 'rm', `${name}-data`], { timeout: 30000 })
      }
      response.writeHead(204).end(); return
    }
    let body
    if (request.method === 'POST') {
      let bytes = 0
      const chunks = []
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 2_128_000) { response.writeHead(413).end(); return }; chunks.push(chunk) }
      body = Buffer.concat(chunks)
    }
    if (!starting.has(id)) starting.set(id, start(id, token).finally(() => starting.delete(id)))
    const origin = await starting.get(id)
    const upstream = await fetch(`${origin}/${match[2]}${url.search}`, { method: request.method, body,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) })
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' })
    const data = await upstream.arrayBuffer()
    if (data.byteLength > 2_128_000) throw new Error('Runtime output too large')
    response.end(Buffer.from(data))
  } catch { response.writeHead(502).end('Agent executor unavailable') }
}).listen(Number(process.env.PORT || 8081), '0.0.0.0')

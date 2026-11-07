// A repository standing in for GitHub or Gitea in scripts/test-factory-workspace.mjs: Git's own HTTP backend
// behind the check the Server's publish route makes, from shared/git-pktline.ts, for one approved push.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { inspectReceivePack } from '/opt/shared/git-pktline.ts'

// A base branch (a direct_push Git flow) moves only from the head the Server read: EXPECTED_OLD.
const expected = { ref: process.env.EXPECTED_REF, sha: process.env.EXPECTED_SHA, ...(process.env.EXPECTED_OLD ? { old: process.env.EXPECTED_OLD } : {}) }
const prefix = `/api/compute-agent/publish/${process.env.APPROVAL}.git`
createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (request.headers.authorization !== `Bearer ${process.env.CAPABILITY}` || !url.pathname.startsWith(prefix)) { response.writeHead(403).end(); return }
  const suffix = url.pathname.slice(prefix.length)
  let body = Readable.toWeb(request)
  if (request.method === 'POST' && suffix === '/git-receive-pack') {
    const inspected = await inspectReceivePack(body, expected)
    if ('refusal' in inspected) { console.log('refused', inspected.refusal); response.writeHead(403).end(inspected.refusal); return }
    body = inspected.body
  }
  const child = spawn('git', ['http-backend'], { env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: '/remote', GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: '/repo.git' + suffix, QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers['content-type'] ?? '', REMOTE_USER: 'publisher', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/tmp' }, stdio: ['pipe', 'pipe', 'inherit'] })
  Readable.fromWeb(body).pipe(child.stdin)
  child.stdin.on('error', () => {})
  let head = Buffer.alloc(0), open = false
  child.stdout.on('data', chunk => {
    if (open) { response.write(chunk); return }
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end < 0) return
    let status = 200
    for (const line of head.subarray(0, end).toString().split('\r\n')) {
      const at = line.indexOf(':'), name = line.slice(0, at), value = line.slice(at + 1).trim()
      if (name.toLowerCase() === 'status') status = Number(value.slice(0, 3)); else if (at > 0) response.setHeader(name, value)
    }
    response.writeHead(status); open = true
    response.write(head.subarray(end + 4))
  })
  child.on('close', () => { if (!open) response.writeHead(502); response.end() })
}).listen(8080, '127.0.0.1', () => console.log('listening'))

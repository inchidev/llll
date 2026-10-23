import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// Optional network acceptance probe; never reads the operator's OpenCode credentials.
// This proves the native SDK session, not L4's Pi inference gateway.
const root = await mkdtemp(join(tmpdir(), 'l4-opencode-'))
const version = '2.1.4'
let host, session, timeout
const abort = new AbortController()
try {
  await promisify(execFile)('npm', ['install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', `@opencode/sdk@${version}`], { timeout: 120000, maxBuffer: 1000000 })
  for (const kind of ['CONFIG', 'DATA', 'STATE', 'CACHE']) process.env[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
  // Override any inherited inline configuration too; the temporary directory has no project config.
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugins: [] })
  for (const key of Object.keys(process.env)) if (/^(?:OPENCODE|OPENAI|ANTHROPIC|OPENROUTER|AWS|GOOGLE|GEMINI|AZURE|CLOUDFLARE)_/u.test(key) && key !== 'OPENCODE_CONFIG_CONTENT') delete process.env[key]
  const installed = JSON.parse(await readFile(join(root, 'node_modules/@opencode/sdk/package.json'), 'utf8'))
  assert.equal(installed.version, version)
  const { OpenCode } = await import(pathToFileURL(join(root, 'node_modules/@opencode/sdk/dist/index.js')).href)
  host = await OpenCode.create({
    // The inference service checks the embedded OpenCode engine's semver, not L4's product version.
    app: { name: 'l4', version: installed.version, channel: 'oss' },
    config: { project: false, claude: false, content: process.env.OPENCODE_CONFIG_CONTENT },
    fs: { fff: false, filewatcher: false }, models: { fetch: true }, log: { level: 'error' },
  })
  const text = []
  let settle
  const done = new Promise(resolve => { settle = resolve })
  const events = (async () => {
    for await (const event of host.events.subscribe({ signal: abort.signal })) {
      const data = event.data
      if (!data || data.sessionID !== session?.id) continue
      if (event.type === 'permission.asked') await host.permission.reply({ sessionID: data.sessionID, requestID: data.id, decision: 'reject', message: 'This acceptance probe does not execute tools.' })
      if (event.type === 'session.text.ended') text.push(data.text)
      if (event.type === 'session.execution.failed') { settle('failed'); return }
      if (event.type === 'session.execution.succeeded') { settle('success'); return }
    }
  })().catch(() => settle('stream-lost'))
  const project = join(root, 'project')
  await mkdir(project)
  session = await host.session.create({
    location: { directory: project }, title: 'L4 free-model acceptance',
    model: { providerID: 'opencode', id: 'glm-5.3-flash-free' },
    // Removing native tool declarations with a blanket deny causes FreeTierError.
    // Keep declarations, but reject every attempted execution at the permission boundary.
    permissions: [{ action: '*', resource: '*', effect: 'ask' }],
  })
  await host.session.prompt({ sessionID: session.id, text: 'Reply exactly OK. Do not use tools.' })
  timeout = setTimeout(() => settle('timeout'), 60000)
  assert.equal(await done, 'success', 'The native OpenCode free-model session did not succeed')
  assert.equal(text.join('\n').trim(), 'OK')
  abort.abort()
  await events
  console.log(`PASS: isolated OpenCode SDK ${version}, anonymous GLM 5.3 Flash, response OK; no tools executed`)
} finally {
  clearTimeout(timeout)
  abort.abort()
  if (session) await host?.session.remove({ sessionID: session.id }).catch(() => {})
  await host?.close()
  await rm(root, { recursive: true, force: true })
}

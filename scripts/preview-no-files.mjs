import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { previewDeployment, wranglerPreviewOutput } from './preview-report.mjs'

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('This Worker Preview smoke runs only in GitHub Actions')
const root = resolve(import.meta.dirname, '..')
const pr = process.env.LLLL_PREVIEW_PR || ''
if (!/^[1-9][0-9]*$/u.test(pr)) throw new Error('Preview PR number is required')
const config = JSON.parse(await readFile(join(root, '.wrangler.preview.generated.jsonc'), 'utf8'))
config.previews.r2_buckets = []
const configPath = join(root, '.wrangler.preview-no-files.generated.jsonc')
const outputPath = join(root, '.preview', 'no-files.ndjson')
await writeFile(configPath, JSON.stringify(config))
const deployed = spawnSync('pnpm', ['exec', 'wrangler', 'preview', '--name', `pr-${pr}-no-files`, '--config', configPath,
  '--secrets-file', '.preview/secrets.json', '--ignore-base-config', '--json'], {
  cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_OUTPUT_FILE_PATH: outputPath },
})
if (deployed.stdout) process.stdout.write(deployed.stdout)
if (deployed.stderr) process.stderr.write(deployed.stderr)
if (deployed.error || deployed.status !== 0) throw new Error('No-R2 Worker Preview deployment failed')
const { previewUrl } = previewDeployment(wranglerPreviewOutput(await readFile(outputPath, 'utf8')))
const origin = new URL(previewUrl).origin
let health
for (let retry = 0; retry < 20; retry++) {
  try {
    const response = await fetch(`${origin}/api/setup/health`)
    if (response.ok) {
      health = await response.json()
      if (health.ok && health.ready) break
    }
  }
  catch { /* deployment propagation */ }
  await new Promise(resolve => setTimeout(resolve, 3000))
}
assert.equal(health?.ok, true)
assert.equal(health?.ready, true)
assert.equal(health?.bindings.r2, false)
const login = await fetch(`${origin}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify({ email: process.env.LLLL_PREVIEW_ADMIN_EMAIL, password: process.env.LLLL_PREVIEW_ADMIN_PASSWORD }),
})
assert.equal(login.status, 200, 'Password login must work without R2')
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const me = await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } })
assert.equal(me.status, 200, 'Authenticated workspace must work without R2')
const backup = await fetch(`${origin}/api/workspaces/main/backup`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } })
assert.equal(backup.status, 409)
assert.equal((await backup.json()).error?.code, 'files_disabled')
console.log(`No-R2 Worker verified: ready workspace, password login, authenticated session, and explicit backup-disabled error. Preview: ${origin}`)

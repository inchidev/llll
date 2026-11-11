import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// `tauri build`, and with PARTYPORTAL_APP set to a built PartyPortal.app, that app goes into
// L4.app/Contents/Helpers, where the app opens Portal links with it before any other copy (ADR 0014).
// Without it the build is the same as before and Portal uses a PartyPortal installed on the Mac.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = ['build', ...process.argv.slice(2)]

const helper = process.env.PARTYPORTAL_APP
if (helper) {
  const app = resolve(helper)
  const plist = resolve(app, 'Contents/Info.plist')
  if (!app.endsWith('.app') || !existsSync(plist) || !statSync(app).isDirectory()) {
    console.error(`PARTYPORTAL_APP is not a built app: ${app}`)
    process.exit(1)
  }
  if (!readFileSync(plist, 'utf8').includes('<string>partyportal</string>')) {
    console.error(`PARTYPORTAL_APP does not open partyportal:// links: ${app}`)
    process.exit(1)
  }
  // Merged into tauri.conf.json; the Share extension is listed again so the merge cannot lose it.
  const config = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const files = { ...config.bundle.macOS.files, 'Helpers/PartyPortal.app': app }
  args.push('--config', JSON.stringify({ bundle: { macOS: { files } } }))
  console.log(`Bundling PartyPortal from ${app}`)
}

execFileSync('tauri', args, { cwd: root, stdio: 'inherit' })

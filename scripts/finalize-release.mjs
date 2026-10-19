import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { sha256, validateDeploymentBundle, writeReleaseManifest } from './release-artifacts.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RELEASE_PR) throw new Error('Only the release-PR workflow can finalize release artifacts')
const directory = resolve('.installer/release')
const json = async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'))
const bundle = await json('llll-deployment.json')
validateDeploymentBundle(bundle, process.env.RELEASE_VERSION)
const installer = await json('llll-cloudflare-manifest.json')
if (installer.version !== process.env.RELEASE_VERSION) throw new Error('Installer version mismatch')
for (const [key, name] of [['worker', 'llll-worker.mjs'], ['assets', 'llll-assets.json']]) {
  const bytes = await readFile(resolve(directory, name))
  if (bytes.length !== installer[key].size || sha256(bytes) !== installer[key].sha256
    || installer[key].url !== `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/${process.env.RELEASE_TAG}/${name}`) throw new Error('Installer asset mismatch')
}
if (JSON.stringify((await json('llll-assets.json')).migrations) !== JSON.stringify(bundle.migrations.server)) throw new Error('Installer migrations differ from the deployment bundle')
await writeReleaseManifest(resolve('.installer/release'), { version: process.env.RELEASE_VERSION, commit: process.env.RELEASE_COMMIT, releasePr: Number(process.env.RELEASE_PR) })
console.log('Verified complete llll / Server / Docs release bundle')

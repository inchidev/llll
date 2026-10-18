import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseVersion } from './release-policy.mjs'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export function validateReleaseManifest(manifest, tag, commit) {
  parseVersion(manifest.version)
  if (!/^[a-f0-9]{40}$/.test(commit) || ![1, 2].includes(manifest.schemaVersion) || `v${manifest.version}` !== tag || manifest.commit !== commit
    || !Number.isSafeInteger(manifest.releasePr) || manifest.releasePr < 1
    || JSON.stringify(manifest.components) !== JSON.stringify(manifest.schemaVersion === 1 ? ['llll', 'server', 'instance', 'docs'] : ['llll', 'server', 'docs'])) throw new Error('Release provenance does not match the immutable tag')
  for (const name of ['llll.tgz', 'llll-deployment.json', 'llll-cloudflare-manifest.json', 'llll-runtime-linux-amd64.tar.gz', 'llll-docs.tgz', 'llll-worker.mjs', 'llll-assets.json', `llll-deployment-core-${manifest.version}.tgz`]) {
    if (!/^[a-f0-9]{64}$/.test(manifest.files?.[name]?.sha256) || !Number.isSafeInteger(manifest.files[name].size) || manifest.files[name].size <= 0) throw new Error(`Incomplete release: ${name}`)
  }
}
export function validateArchivePaths(paths, listing) {
  if (paths.some(path => path.startsWith('/') || path.split('/').includes('..') || !/^(?:\.bundle\/|\.output\/public(?:\/|$)|migrations(?:\/|$)|wrangler\.jsonc$)/.test(path))
    || listing.split('\n').filter(Boolean).some(line => !['-', 'd'].includes(line[0]))) throw new Error('Unsafe web release archive')
}
export function validateDeploymentBundle(bundle, version) {
  if (bundle.schemaVersion !== 2 || bundle.version !== version) throw new Error('Deployment bundle version mismatch')
  for (const name of ['site', 'client', 'server']) {
    const module = bundle.modules?.[name]
    if (!module || Buffer.byteLength(module.content) !== module.size || sha256(module.content) !== module.sha256) throw new Error(`Invalid ${name} module`)
  }
  if (!Array.isArray(bundle.assets) || !bundle.assets.length) throw new Error('Client assets are missing')
  const seen = new Set()
  for (const asset of bundle.assets) {
    const bytes = Buffer.from(asset.contentBase64, 'base64')
    if (!asset.path.startsWith('/') || asset.path.split('/').includes('..') || seen.has(asset.path)
      || bytes.length !== asset.size || createHash('md5').update(bytes).digest('hex') !== asset.hash) throw new Error('Invalid client asset')
    seen.add(asset.path)
  }
  for (const kind of ['server']) {
    const migrations = bundle.migrations?.[kind]
    if (!Array.isArray(migrations) || !migrations.length) throw new Error(`Missing ${kind} migrations`)
    for (const [index, migration] of migrations.entries()) {
      if (!new RegExp(`^${String(index).padStart(4, '0')}_[a-z0-9_]+\\.sql$`).test(migration.name) || !migration.sql.trim()) throw new Error(`Invalid ${kind} migration order`)
    }
  }
}
export async function writeReleaseManifest(directory, { version, commit, releasePr }) {
  const files = {}
  for (const name of (await readdir(directory)).sort()) {
    if (['SHA256SUMS', 'llll-release.json'].includes(name)) continue
    const bytes = await readFile(resolve(directory, name))
    files[name] = { sha256: sha256(bytes), size: bytes.length }
  }
  const manifest = { schemaVersion: 2, version, commit, releasePr, components: ['llll', 'server', 'docs'], files }
  validateReleaseManifest(manifest, `v${version}`, commit)
  await writeFile(resolve(directory, 'llll-release.json'), JSON.stringify(manifest, null, 2) + '\n')
  let sums = ''
  for (const name of (await readdir(directory)).sort()) if (name !== 'SHA256SUMS') sums += `${sha256(await readFile(resolve(directory, name)))}  ${name}\n`
  await writeFile(resolve(directory, 'SHA256SUMS'), sums)
  return manifest
}

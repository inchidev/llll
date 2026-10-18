import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireWorkersBuild } from './ci-only.mjs'
import { compareVersions, parseVersion } from './release-policy.mjs'
import { sha256, validateArchivePaths, validateReleaseManifest } from './release-artifacts.mjs'

requireWorkersBuild()
if (process.env.WORKERS_CI_BRANCH !== 'main') throw new Error('Only main may prepare production')
const root = resolve(import.meta.dirname, '..'), work = resolve(root, '.deployment/released')
await mkdir(work, { recursive: true })
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const repository = 'https://github.com/inchidev/llll.git'
const response = await fetch('https://llll.gg/api/health', { signal: AbortSignal.timeout(15000) })
if (!response.ok) throw new Error('Cannot verify the currently deployed version')
const live = await response.json()
if (!/^[a-f0-9]{40}$/.test(live.commit)) throw new Error('Production did not identify its commit')
if (!live.version) {
  git(['fetch', '--no-tags', '--depth=1', repository, live.commit])
  live.version = JSON.parse(git(['show', `${live.commit}:package.json`])).version
}
parseVersion(live.version)
const tags = git(['ls-remote', '--refs', repository, 'refs/tags/v*']).split('\n').flatMap(line => {
  const [commit, ref] = line.split(/\s+/), tag = ref?.replace('refs/tags/', '')
  try { parseVersion(tag?.slice(1)); return [{ tag, commit, version: tag.slice(1) }] } catch { return [] }
}).filter(tag => compareVersions(tag.version, live.version) > 0).sort((a, b) => compareVersions(b.version, a.version))
let plan = { skip: true, reason: 'No newer published release: production unchanged', liveVersion: live.version, liveCommit: live.commit }
for (const candidate of tags) {
  const base = `https://github.com/inchidev/llll/releases/download/${candidate.tag}`
  const manifestResponse = await fetch(`${base}/llll-release.json`, { signal: AbortSignal.timeout(20000) })
  if (manifestResponse.status === 404) continue // Unpublished/draft tags cannot deploy.
  if (!manifestResponse.ok) throw new Error('Cannot verify published release manifest')
  const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer()), manifest = JSON.parse(manifestBytes)
  git(['fetch', '--no-tags', '--depth=2', repository, `refs/tags/${candidate.tag}`])
  const commit = git(['rev-parse', 'FETCH_HEAD^{commit}'])
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') git(['fetch', '--unshallow', '--no-tags', repository, 'main'])
  git(['merge-base', '--is-ancestor', commit, process.env.WORKERS_CI_COMMIT_SHA])
  validateReleaseManifest(manifest, candidate.tag, commit)
  const versionAt = revision => JSON.parse(git(['show', `${revision}:package.json`])).version
  if (versionAt(commit) !== candidate.version || compareVersions(candidate.version, versionAt(`${commit}^`)) <= 0) throw new Error('Release tag did not change version')
  const sumsResponse = await fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(20000) })
  if (!sumsResponse.ok) throw new Error('Release checksums are missing')
  const sums = new Map((await sumsResponse.text()).trim().split('\n').map(line => { const [hash, name] = line.split(/\s+/); return [name, hash] }))
  if (sums.get('llll-release.json') !== sha256(manifestBytes)) throw new Error('Release manifest checksum mismatch')
  const archiveResponse = await fetch(`${base}/llll.tgz`, { signal: AbortSignal.timeout(60000) })
  if (!archiveResponse.ok) throw new Error('Released web archive is missing')
  const archive = Buffer.from(await archiveResponse.arrayBuffer())
  if (archive.length !== manifest.files['llll.tgz'].size || sha256(archive) !== manifest.files['llll.tgz'].sha256 || sums.get('llll.tgz') !== sha256(archive)) throw new Error('Released web archive checksum mismatch')
  const path = resolve(work, 'llll.tgz'), site = resolve(work, 'site')
  await writeFile(path, archive)
  const list = args => execFileSync('tar', args, { encoding: 'utf8' })
  validateArchivePaths(list(['-tzf', path]).trim().split('\n'), list(['-tvzf', path]))
  await rm(site, { recursive: true, force: true })
  await mkdir(site, { recursive: true })
  list(['-xzf', path, '--no-same-owner', '--no-same-permissions', '-C', site])
  plan = { skip: false, version: candidate.version, commit, tag: candidate.tag, site }
  break
}
await writeFile(resolve(work, 'plan.json'), JSON.stringify(plan))
console.log(plan.skip ? plan.reason : `Verified immutable release ${plan.tag} (${plan.commit}) for production`)

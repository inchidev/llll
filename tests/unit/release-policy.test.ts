import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { compareVersions, parseVersion, releasePlan } from '../../scripts/release-policy.mjs'
import { sha256, validateArchivePaths, validateDeploymentBundle, validateReleaseManifest } from '../../scripts/release-artifacts.mjs'

const ordinary = { previous: '0.1.0-alpha.1', version: '0.1.0-alpha.1', libraryVersion: '0.1.0-alpha.1', releasePr: false, notesExist: true }
const next = { ...ordinary, version: '0.1.0-alpha.2', libraryVersion: '0.1.0-alpha.2', releasePr: true }

describe('release PR policy', () => {
  it('keeps ordinary merges out of releases and production', () => {
    expect(releasePlan(ordinary).release).toBe(false)
    expect(releasePlan({ ...ordinary, notesExist: false }).release).toBe(false)
  })
  it('requires the release label, a shared higher version and notes', () => {
    expect(releasePlan(next)).toEqual({ release: true, version: next.version, tag: 'v0.1.0-alpha.2' })
    expect(() => releasePlan({ ...next, releasePr: false })).toThrow('labelled release')
    expect(() => releasePlan({ ...ordinary, releasePr: true })).toThrow('change version')
    expect(() => releasePlan({ ...next, notesExist: false })).toThrow('release notes')
    expect(() => releasePlan({ ...next, libraryVersion: ordinary.version })).toThrow('share')
    expect(() => releasePlan({ ...next, previous: '0.1.0' })).toThrow('increase')
  })
  it('orders the full SemVer prerelease sequence and rejects ambiguous versions', () => {
    const versions = ['0.1.0-alpha', '0.1.0-alpha.1', '0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta', '0.1.0-rc.1', '0.1.0', '0.2.0']
    for (let index = 1; index < versions.length; index++) {
      expect(compareVersions(versions[index]!, versions[index - 1]!)).toBe(1)
      expect(compareVersions(versions[index - 1]!, versions[index]!)).toBe(-1)
    }
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-alpha.99999999999999999', '1.0.0-alpha.99999999999999998')).toBe(1)
    for (const value of ['v1.0.0', '01.0.0', '1.0.0-alpha.01', '1.0.0+build', '1.0', '9007199254740992.0.0']) expect(() => parseVersion(value)).toThrow()
  })
})

describe('release artifact provenance', () => {
  const commit = 'a'.repeat(40)
  const files = Object.fromEntries(['llll.tgz', 'llll-deployment.json', 'llll-cloudflare-manifest.json', 'llll-runtime-linux-amd64.tar.gz', 'llll-docs.tgz', 'llll-worker.mjs', 'llll-assets.json', 'llll-deployment-core-0.1.0-alpha.2.tgz'].map(name => [name, { sha256: 'b'.repeat(64), size: 100 }]))
  const manifest = { schemaVersion: 3, version: next.version, commit, releasePr: 42, components: ['llll', 'server', 'docs'], files }
  it('requires the matching immutable tag, commit and all components', () => {
    expect(() => validateReleaseManifest(manifest, 'v0.1.0-alpha.2', commit)).not.toThrow()
    expect(() => validateReleaseManifest(manifest, 'v0.1.0-alpha.3', commit)).toThrow()
    expect(() => validateReleaseManifest(manifest, 'v0.1.0-alpha.2', 'c'.repeat(40))).toThrow()
    expect(() => validateReleaseManifest({ ...manifest, files: { ...files, 'llll-docs.tgz': undefined } }, 'v0.1.0-alpha.2', commit)).toThrow('Incomplete')
  })
  it('rejects archive traversal and links before extraction', () => {
    expect(() => validateArchivePaths(['.bundle/index.mjs', '.output/public/index.html', 'migrations/0000_web_baseline.sql', 'wrangler.jsonc'], '-rw-r--r-- file\ndrwxr-xr-x directory\n')).not.toThrow()
    for (const path of ['/tmp/file', '.output/public/../../bad', '.bundle/../../../bad', 'scripts/web-deploy.mjs']) expect(() => validateArchivePaths([path], '-rw-r--r-- file')).toThrow()
    expect(() => validateArchivePaths(['.bundle/index.mjs'], 'lrwxr-xr-x link -> /etc/passwd')).toThrow()
  })
  it('requires every VPS asset only on releases declaring the installer capability', () => {
    const vpsFiles = Object.fromEntries(['install.sh', 'llll', 'llll-compose.yml', 'compose.vps.yml', 'Caddyfile', 'Caddyfile.vps'].map(name => [name, { sha256: 'd'.repeat(64), size: 100 }]))
    const vps = { ...manifest, vpsInstaller: 1, files: { ...files, ...vpsFiles } }
    expect(() => validateReleaseManifest(vps, 'v0.1.0-alpha.2', commit)).not.toThrow()
    expect(() => validateReleaseManifest({ ...vps, files }, 'v0.1.0-alpha.2', commit)).toThrow('Incomplete VPS')
    expect(() => validateReleaseManifest(manifest, 'v0.1.0-alpha.2', commit)).not.toThrow()
  })
  it('rejects a corrupt component and missing migration chain', () => {
    const content = 'export default {}'
    const bundle = { schemaVersion: 3, version: next.version, modules: Object.fromEntries(['site', 'client', 'server'].map(name => [name, { content, size: content.length, sha256: sha256(content) }])), assets: [{ path: '/index.html', contentBase64: 'aGVsbG8=', size: 5, hash: '5d41402abc4b2a76b9719d911017c592' }], migrations: { server: [{ name: '0000_server_baseline.sql', sql: 'CREATE TABLE users(id);' }] } }
    expect(() => validateDeploymentBundle(bundle, next.version)).not.toThrow()
    expect(() => validateDeploymentBundle({ ...bundle, modules: { ...bundle.modules, server: { content: 'corrupted' } } }, next.version)).toThrow('server module')
    expect(() => validateDeploymentBundle({ ...bundle, migrations: { ...bundle.migrations, server: [] } }, next.version)).toThrow('server migrations')
  })
})

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
it('a production no-op exits successfully without Cloudflare credentials or deployment tools', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'llll-release-gate-'))
  temporary.push(root)
  mkdirSync(resolve(root, 'scripts'))
  for (const name of ['web-deploy.mjs', 'cloudflare-d1.mjs', 'ci-only.mjs', 'pull-request-ref.mjs', 'release-policy.mjs']) cpSync(resolve('scripts', name), resolve(root, 'scripts', name))
  mkdirSync(resolve(root, '.deployment/released'), { recursive: true })
  writeFileSync(resolve(root, '.deployment/released/plan.json'), JSON.stringify({ skip: true, reason: 'No newer published release: production unchanged' }))
  const output = execFileSync(process.execPath, [resolve(root, 'scripts/web-deploy.mjs'), 'production'], { encoding: 'utf8', env: { CI: 'true', WORKERS_CI: '1', WORKERS_CI_BUILD_UUID: 'isolated-test', WORKERS_CI_BRANCH: 'main', PATH: '/no-deployment-tools' } })
  expect(output).toContain('production unchanged')
  expect(() => execFileSync(process.execPath, [resolve(root, 'scripts/web-deploy.mjs'), 'production'], { env: { PATH: '/no-deployment-tools' }, stdio: 'pipe' })).toThrow()
})
it('the production resolver ignores existing tags and writes a no-op plan without fetching artifacts', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'llll-production-plan-'))
  temporary.push(root)
  mkdirSync(resolve(root, 'scripts'))
  mkdirSync(resolve(root, 'bin'))
  for (const name of ['prepare-production.mjs', 'ci-only.mjs', 'release-policy.mjs', 'release-artifacts.mjs']) cpSync(resolve('scripts', name), resolve(root, 'scripts', name))
  const preloader = resolve(root, 'fetch.mjs')
  writeFileSync(preloader, `globalThis.fetch = async url => { if (url !== 'https://llll.gg/api/health') throw new Error('Unexpected release artifact request'); return Response.json({commit:'${'a'.repeat(40)}',version:'0.1.0-alpha.1'}); }`)
  writeFileSync(resolve(root, 'bin/git'), `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== 'ls-remote --refs https://github.com/inchidev/llll.git refs/tags/v*') process.exit(1); console.log('${'a'.repeat(40)}\\trefs/tags/v0.1.0-alpha.1');`, { mode: 0o755 })
  const env = { CI: 'true', WORKERS_CI: '1', WORKERS_CI_BUILD_UUID: 'isolated-test', WORKERS_CI_BRANCH: 'main', PATH: resolve(root, 'bin') }
  const output = execFileSync(process.execPath, ['--import', preloader, resolve(root, 'scripts/prepare-production.mjs')], { encoding: 'utf8', env })
  expect(output).toContain('No newer published release: production unchanged')
})
it('prepares the released archive instead of newer main output and rejects corrupted downloads', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'llll-released-artifact-'))
  temporary.push(root)
  for (const path of ['scripts', 'bin', 'archive/.bundle', 'archive/.output/public', 'archive/migrations', '.deployment/released/site']) mkdirSync(resolve(root, path), { recursive: true })
  for (const name of ['prepare-production.mjs', 'ci-only.mjs', 'release-policy.mjs', 'release-artifacts.mjs']) cpSync(resolve('scripts', name), resolve(root, 'scripts', name))
  writeFileSync(resolve(root, '.deployment/released/site/stale'), 'cached unreleased file')
  writeFileSync(resolve(root, 'archive/.bundle/index.mjs'), 'released web code')
  writeFileSync(resolve(root, 'archive/.output/public/index.html'), 'released page')
  writeFileSync(resolve(root, 'archive/migrations/0000_web_baseline.sql'), 'CREATE TABLE example(id);')
  writeFileSync(resolve(root, 'archive/wrangler.jsonc'), '{"name":"llll"}')
  const tar = resolve(root, 'web.tgz')
  execFileSync('tar', ['-czf', tar, '-C', resolve(root, 'archive'), '.bundle/index.mjs', '.output/public', 'migrations', 'wrangler.jsonc'])
  const bytes = readFileSync(tar), commit = 'b'.repeat(40), main = 'c'.repeat(40)
  const files = Object.fromEntries(['llll.tgz', 'llll-deployment.json', 'llll-cloudflare-manifest.json', 'llll-runtime-linux-amd64.tar.gz', 'llll-docs.tgz', 'llll-worker.mjs', 'llll-assets.json', 'llll-deployment-core-0.1.0-alpha.2.tgz'].map(name => [name, { sha256: sha256(bytes), size: bytes.length }]))
  const manifest = JSON.stringify({ schemaVersion: 3, version: next.version, commit, releasePr: 42, components: ['llll', 'server', 'docs'], files })
  const base = 'https://github.com/inchidev/llll/releases/download/v0.1.0-alpha.2'
  const responses = { 'https://llll.gg/api/health': JSON.stringify({ commit: 'a'.repeat(40), version: ordinary.version }), [`${base}/llll-release.json`]: manifest, [`${base}/SHA256SUMS`]: `${sha256(manifest)}  llll-release.json\n${sha256(bytes)}  llll.tgz` }
  const preloader = resolve(root, 'fetch.mjs')
  const mockFetch = (corrupt: boolean) => writeFileSync(preloader, `const responses=${JSON.stringify(responses)}; globalThis.fetch=async url=>{if(url==='${base}/llll.tgz')return new Response(Buffer.from('${(corrupt ? Buffer.from('corrupted') : bytes).toString('base64')}','base64'));if(!(url in responses))throw new Error('Unexpected request');return new Response(responses[url]);}`)
  writeFileSync(resolve(root, 'bin/git'), `#!${process.execPath}\nconst a=process.argv.slice(2);const s=a.join(' ');if(a[0]==='ls-remote') console.log('${commit}\\trefs/tags/v0.1.0-alpha.2');else if(a[0]==='fetch'){}else if(s==='rev-parse FETCH_HEAD^{commit}')console.log('${commit}');else if(s==='rev-parse --is-shallow-repository')console.log('false');else if(s==='merge-base --is-ancestor ${commit} ${main}'){}else if(s==='show ${commit}:package.json')console.log('{"version":"0.1.0-alpha.2"}');else if(s==='show ${commit}^:package.json')console.log('{"version":"0.1.0-alpha.1"}');else process.exit(1);`, { mode: 0o755 })
  // Restrict Git to the stub; the real tar only reads/writes this isolated fixture.
  const env = { CI: 'true', WORKERS_CI: '1', WORKERS_CI_BUILD_UUID: 'isolated-test', WORKERS_CI_BRANCH: 'main', WORKERS_CI_COMMIT_SHA: main, PATH: `${resolve(root, 'bin')}:/usr/bin:/bin` }
  mockFetch(false)
  execFileSync(process.execPath, ['--import', preloader, resolve(root, 'scripts/prepare-production.mjs')], { env, stdio: 'pipe' })
  const plan = JSON.parse(readFileSync(resolve(root, '.deployment/released/plan.json'), 'utf8'))
  expect(plan).toMatchObject({ skip: false, version: next.version, commit })
  expect(readFileSync(resolve(plan.site, '.bundle/index.mjs'), 'utf8')).toBe('released web code')
  expect(() => readFileSync(resolve(plan.site, 'stale'))).toThrow()
  mockFetch(true)
  expect(() => execFileSync(process.execPath, ['--import', preloader, resolve(root, 'scripts/prepare-production.mjs')], { env, stdio: 'pipe' })).toThrow('checksum mismatch')
})
it('retries a hook that reused a main Build started before release publication', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'llll-release-hook-'))
  temporary.push(root)
  const script = resolve(root, 'trigger.mjs'), preloader = resolve(root, 'fetch.mjs')
  cpSync(resolve('scripts/trigger-release-deploy.mjs'), script)
  writeFileSync(preloader, `let posts=0; globalThis.setTimeout=fn=>{queueMicrotask(fn);return 0};globalThis.fetch=async(url,init)=>{if(init?.method==='POST'){if(url!=='https://invalid.example/hook')throw new Error('Unexpected hook');posts++;return Response.json({success:true,result:{already_exists:posts===1}})}if(url!=='https://llll.gg/api/health')throw new Error('Unexpected URL');if(posts===2)return Response.json({commit:'${'b'.repeat(40)}',version:'0.1.0-alpha.2'});return Response.json({commit:'${'a'.repeat(40)}',version:'0.1.0-alpha.1'})}`)
  const output = execFileSync(process.execPath, ['--import', preloader, script], { encoding: 'utf8', env: { GITHUB_ACTIONS: 'true', RELEASE_HOOK: 'https://invalid.example/hook', RELEASE_COMMIT: 'b'.repeat(40), RELEASE_VERSION: next.version, PATH: '/no-deployment-tools' } })
  expect(output).toContain('Production verified: v0.1.0-alpha.2')
})

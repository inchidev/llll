import { describe, expect, it } from 'vitest'
import { compareVersions, parseVersion, releasePlan } from '../../scripts/release-policy.mjs'
import { sha256, validateDeploymentBundle, validateReleaseManifest } from '../../scripts/release-artifacts.mjs'

const ordinary = { previous: '0.1.0-alpha.1', version: '0.1.0-alpha.1', libraryVersion: '0.1.0-alpha.1', releasePr: false, notesExist: true }
const next = { ...ordinary, version: '0.1.0-alpha.2', libraryVersion: '0.1.0-alpha.2', releasePr: true }

describe('release PR policy', () => {
  it('keeps ordinary merges out of releases', () => {
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
  const files = Object.fromEntries(['llll-deployment.json', 'llll-cloudflare-manifest.json', 'llll-runtime-linux-amd64.tar.gz', 'llll-docs.tgz', 'llll-worker.mjs', 'llll-assets.json', 'llll-deployment-core-0.1.0-alpha.2.tgz'].map(name => [name, { sha256: 'b'.repeat(64), size: 100 }]))
  const manifest = { schemaVersion: 3, version: next.version, commit, releasePr: 42, components: ['server', 'docs'], files }
  it('requires the matching immutable tag, commit and all components', () => {
    expect(() => validateReleaseManifest(manifest, 'v0.1.0-alpha.2', commit)).not.toThrow()
    expect(() => validateReleaseManifest(manifest, 'v0.1.0-alpha.3', commit)).toThrow()
    expect(() => validateReleaseManifest(manifest, 'v0.1.0-alpha.2', 'c'.repeat(40))).toThrow()
    expect(() => validateReleaseManifest({ ...manifest, files: { ...files, 'llll-docs.tgz': undefined } }, 'v0.1.0-alpha.2', commit)).toThrow('Incomplete')
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
    const bundle = { schemaVersion: 3, version: next.version, modules: Object.fromEntries(['server'].map(name => [name, { content, size: content.length, sha256: sha256(content) }])), assets: [{ path: '/index.html', contentBase64: 'aGVsbG8=', size: 5, hash: '5d41402abc4b2a76b9719d911017c592' }], migrations: { server: [{ name: '0000_baseline.sql', sql: 'CREATE TABLE users(id);' }] } }
    expect(() => validateDeploymentBundle(bundle, next.version)).not.toThrow()
    expect(() => validateDeploymentBundle({ ...bundle, modules: { ...bundle.modules, server: { content: 'corrupted' } } }, next.version)).toThrow('server module')
    expect(() => validateDeploymentBundle({ ...bundle, migrations: { ...bundle.migrations, server: [] } }, next.version)).toThrow('server migrations')
  })
})

import { mkdir, copyFile, cp, writeFile, readFile, rename } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const version = JSON.parse(await readFile('package.json')).version
const output = resolve('.installer/factory'), staging = join(output, 'node')
await mkdir(staging, { recursive: true })
await cp('packages/compute-node/src', join(staging, 'src'), { recursive: true })
// Build on Node24 bookworm, matching the supported Debian12+ host ABI.
await copyFile(process.execPath, join(staging, 'node'))
await copyFile(resolve(import.meta.dirname, '../packages/compute-node/LICENSE.node'), join(staging, 'LICENSE.node'))
execFileSync('tar', ['-czf', join(output, 'llll-compute-node-linux-amd64.tgz'), '-C', staging, 'node', 'src', 'LICENSE.node'])
const image = `llll-workspace:${version}`
execFileSync('docker', ['build', '--platform', 'linux/amd64', '-t', image, '-f', 'packages/compute-node/Dockerfile.workspace', '.'], { stdio: 'inherit' })
const imageId = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim()
execFileSync('docker', ['save', '-o', join(output, 'workspace.tar'), image], { stdio: 'inherit' })
const cloudImage = image + '-cloud'
execFileSync('docker', ['build', '--platform', 'linux/amd64', '--build-arg', `WORKSPACE_IMAGE=${image}`, '-t', cloudImage, '-f', 'packages/compute-node/Dockerfile.cloud', '.'], { stdio: 'inherit' })
execFileSync('docker', ['save', '-o', join(output, 'cloud-workspace.tar'), cloudImage], { stdio: 'inherit' })
const extracted = join(output, 'image')
await mkdir(extracted, { recursive: true })
execFileSync('tar', ['-xf', join(output, 'cloud-workspace.tar'), '-C', extracted])
const saved = JSON.parse(await readFile(join(extracted, 'manifest.json')))[0]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const layers = []
for (const [index, path] of saved.Layers.entries()) {
  const target = `llll-workspace-layer-${index}.tar.gz`
  const raw = join(output, `layer-${index}.tar`)
  await copyFile(join(extracted, path), raw)
  execFileSync('gzip', ['-1', '-f', raw])
  await rename(raw + '.gz', join(output, target))
  const bytes = await readFile(join(output, target))
  layers.push({ file: target, mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', digest: 'sha256:' + digest(bytes), size: bytes.length })
}
const config = await readFile(join(extracted, saved.Config))
await writeFile(join(output, 'llll-workspace-config.json'), config)
const imageManifest = { schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: config.length, digest: 'sha256:' + digest(config) },
  layers: layers.map(layer => ({ mediaType: layer.mediaType, digest: layer.digest, size: layer.size })) }
const manifestBytes = Buffer.from(JSON.stringify(imageManifest))
await writeFile(join(output, 'llll-workspace-manifest.json'), manifestBytes)
execFileSync('gzip', ['-1', '-f', join(output, 'workspace.tar')])
await copyFile(join(output, 'workspace.tar.gz'), join(output, 'llll-workspace-linux-amd64.tar.gz'))
const files = {}
for (const name of ['llll-compute-node-linux-amd64.tgz', 'llll-workspace-linux-amd64.tar.gz', 'llll-workspace-config.json', 'llll-workspace-manifest.json', ...layers.map(layer => layer.file)]) {
  const bytes = await readFile(join(output, name)); files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}
await writeFile(join(output, 'llll-factory.json'), JSON.stringify({ schemaVersion: 1, version, image: imageId, manifestDigest: 'sha256:' + digest(manifestBytes), layers, files }, null, 2) + '\n')
console.log(`Factory release ${version}: ${imageId}`)

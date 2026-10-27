import { mkdir, copyFile, cp, writeFile, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { encodeFactoryLayer, validateFactoryImage } from './factory-image-layers.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
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
const workspaceExtracted = join(output, 'workspace-image')
await mkdir(workspaceExtracted, { recursive: true })
execFileSync('tar', ['-xf', join(output, 'workspace.tar'), '-C', workspaceExtracted])
const workspaceSaved = JSON.parse(await readFile(join(workspaceExtracted, 'manifest.json')))[0]
const workspaceConfig = await readFile(join(workspaceExtracted, workspaceSaved.Config))
const configDigest = 'sha256:' + digest(workspaceConfig)
let indexDigest
try {
  const indexBytes = await readFile(join(workspaceExtracted, 'index.json'))
  const listed = JSON.parse(indexBytes.toString())?.manifests?.[0]?.digest
  indexDigest = typeof listed === 'string' && /^sha256:[a-f0-9]{64}$/.test(listed) ? listed : 'sha256:' + digest(indexBytes)
} catch { indexDigest = undefined }
const cloudImage = image + '-cloud'
execFileSync('docker', ['build', '--platform', 'linux/amd64', '--build-arg', `WORKSPACE_IMAGE=${image}`, '-t', cloudImage, '-f', 'packages/compute-node/Dockerfile.cloud', '.'], { stdio: 'inherit' })
execFileSync('docker', ['save', '-o', join(output, 'cloud-workspace.tar'), cloudImage], { stdio: 'inherit' })
const extracted = join(output, 'image')
await mkdir(extracted, { recursive: true })
execFileSync('tar', ['-xf', join(output, 'cloud-workspace.tar'), '-C', extracted])
const saved = JSON.parse(await readFile(join(extracted, 'manifest.json')))[0]
const config = await readFile(join(extracted, saved.Config))
const diffIds = JSON.parse(config).rootfs?.diff_ids
if (!Array.isArray(diffIds) || diffIds.length !== saved.Layers.length) throw new Error('Factory image layer count mismatch')
const layers = []
for (const [index, path] of saved.Layers.entries()) {
  const target = `llll-workspace-layer-${index}.tar.gz`
  const bytes = encodeFactoryLayer(await readFile(join(extracted, path)), diffIds[index])
  await writeFile(join(output, target), bytes)
  layers.push({ file: target, mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', digest: 'sha256:' + digest(bytes), size: bytes.length })
}
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
await writeFile(join(output, 'llll-factory.json'), JSON.stringify({ schemaVersion: 1, version, image: imageId, configDigest, ...(indexDigest ? { indexDigest } : {}), manifestDigest: 'sha256:' + digest(manifestBytes), layers, files }, null, 2) + '\n')
validateFactoryImage(output)
console.log(`Factory release ${version}: ${imageId}`)

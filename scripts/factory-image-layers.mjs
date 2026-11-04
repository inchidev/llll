import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gunzipSync, gzipSync } from 'node:zlib'

const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const isGzip = bytes => bytes[0] === 0x1f && bytes[1] === 0x8b

function verifyTar(bytes, diffId) {
  if (isGzip(bytes)) throw new Error('Factory image layer is double-gzipped')
  if (!/^sha256:[a-f0-9]{64}$/.test(diffId) || digest(bytes) !== diffId) throw new Error('Factory image layer diff_id mismatch')
  execFileSync('tar', ['-tf', '-'], { input: bytes, stdio: ['pipe', 'ignore', 'pipe'] })
}

// Docker's classic and containerd stores export different layer encodings.
// Preserve compressed blobs and compress only raw tar, independent of filenames.
export function encodeFactoryLayer(bytes, diffId) {
  const compressed = isGzip(bytes)
  verifyTar(compressed ? gunzipSync(bytes) : bytes, diffId)
  return compressed ? bytes : gzipSync(bytes, { level: 1 })
}

export function validateFactoryImage(directory) {
  const read = name => readFileSync(join(directory, name))
  const factory = JSON.parse(read('llll-factory.json'))
  const manifestBytes = read('llll-workspace-manifest.json')
  const manifest = JSON.parse(manifestBytes)
  const configBytes = read('llll-workspace-config.json')
  const config = JSON.parse(configBytes)
  const diffIds = config.rootfs?.diff_ids
  if (digest(manifestBytes) !== factory.manifestDigest || manifest.schemaVersion !== 2
    || digest(configBytes) !== manifest.config?.digest || configBytes.length !== manifest.config?.size
    || config.rootfs?.type !== 'layers' || !Array.isArray(diffIds) || !diffIds.length
    || manifest.layers?.length !== diffIds.length || factory.layers?.length !== diffIds.length) throw new Error('Factory image descriptor mismatch')
  for (const [index, descriptor] of manifest.layers.entries()) {
    const layer = factory.layers[index]
    if (layer.file !== `llll-workspace-layer-${index}.tar.gz`
      || layer.digest !== descriptor.digest || layer.size !== descriptor.size
      || layer.mediaType !== descriptor.mediaType || descriptor.mediaType !== 'application/vnd.docker.image.rootfs.diff.tar.gzip') throw new Error('Factory image layer descriptor mismatch')
    const bytes = read(layer.file)
    if (digest(bytes) !== descriptor.digest || bytes.length !== descriptor.size || !isGzip(bytes)) throw new Error('Factory image compressed layer mismatch')
    verifyTar(gunzipSync(bytes), diffIds[index])
  }
}

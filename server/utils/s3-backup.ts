import { AwsClient } from 'aws4fetch'
import type { BackupDestinationRuntimeConfig } from './backup-destination'

const DEFAULT_PART_BYTES = 8 * 1024 * 1024

type S3Request = (url: string, init?: RequestInit) => Promise<Response>

function encodeObjectKey(key: string) {
  return key.split('/').map((segment) => {
    if (segment === '.' || segment === '..') throw new Error('S3 object keys cannot contain . or .. path segments')
    return encodeURIComponent(segment)
  }).join('/')
}

export function s3ObjectUrl(config: Pick<BackupDestinationRuntimeConfig, 'endpoint' | 'bucket'>, key: string): string {
  const url = new URL(config.endpoint)
  const basePath = url.pathname.replace(/\/+$/gu, '')
  url.pathname = `${basePath}/${encodeURIComponent(config.bucket)}/${encodeObjectKey(key)}`
  return url.toString()
}

function requestFor(config: BackupDestinationRuntimeConfig): S3Request {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
    retries: 3,
  })
  return (url, init) => client.fetch(url, init)
}

function xmlValue(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'u'))
  if (!match?.[1]) return null
  return match[1]
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

async function requireOk(response: Response, operation: string): Promise<Response> {
  if (response.ok) return response
  const detail = (await response.text()).replace(/\s+/gu, ' ').trim().slice(0, 500)
  throw new Error(`${operation} failed with S3 HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
}

function concatChunks(chunks: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

async function* multipartParts(stream: ReadableStream<Uint8Array>, partBytes: number): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  let chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      let offset = 0
      while (offset < value.byteLength) {
        const take = Math.min(partBytes - size, value.byteLength - offset)
        chunks.push(value.subarray(offset, offset + take))
        size += take
        offset += take
        if (size === partBytes) {
          yield concatChunks(chunks, size)
          chunks = []
          size = 0
        }
      }
    }
    if (size) yield concatChunks(chunks, size)
  }
  finally {
    reader.releaseLock()
  }
}

export function backupObjectKey(prefix: string, createdAt: string, version: string): string {
  const stamp = createdAt.replaceAll(':', '-').replace('.000Z', 'Z')
  const safeVersion = version.replace(/[^a-z0-9._-]/giu, '_')
  const filename = `llll-backup-${stamp}-${safeVersion}.tar`
  return prefix ? `${prefix}/${filename}` : filename
}

export async function testS3Destination(
  config: BackupDestinationRuntimeConfig,
  request: S3Request = requestFor(config),
): Promise<void> {
  const testKey = config.prefix
    ? `${config.prefix}/.llll-connection-test-${crypto.randomUUID()}`
    : `.llll-connection-test-${crypto.randomUUID()}`
  const url = s3ObjectUrl(config, testKey)
  await requireOk(await request(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(),
  }), 'Connection test upload')
  await requireOk(await request(url, { method: 'DELETE' }), 'Connection test cleanup')
}

export async function uploadBackupToS3(
  config: BackupDestinationRuntimeConfig,
  key: string,
  stream: ReadableStream<Uint8Array>,
  options: { request?: S3Request, partBytes?: number } = {},
): Promise<{ sizeBytes: number }> {
  const request = options.request ?? requestFor(config)
  const partBytes = options.partBytes ?? DEFAULT_PART_BYTES
  if (!Number.isSafeInteger(partBytes) || partBytes < 5 * 1024 * 1024) {
    throw new Error('S3 multipart parts must be at least 5 MiB')
  }

  const objectUrl = s3ObjectUrl(config, key)
  const createUrl = new URL(objectUrl)
  createUrl.searchParams.set('uploads', '')
  const createResponse = await requireOk(await request(createUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-tar' },
  }), 'Multipart upload creation')
  const uploadId = xmlValue(await createResponse.text(), 'UploadId')
  if (!uploadId) throw new Error('S3 multipart upload did not return an upload ID')

  const uploaded: Array<{ partNumber: number, etag: string }> = []
  let sizeBytes = 0
  try {
    for await (const part of multipartParts(stream, partBytes)) {
      const partNumber = uploaded.length + 1
      if (partNumber > 10_000) throw new Error('S3 multipart upload exceeded 10,000 parts')
      const partUrl = new URL(objectUrl)
      partUrl.searchParams.set('partNumber', String(partNumber))
      partUrl.searchParams.set('uploadId', uploadId)
      const response = await requireOk(await request(partUrl.toString(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: part,
      }), `Multipart part ${partNumber}`)
      const etag = response.headers.get('etag')
      if (!etag) throw new Error(`Multipart part ${partNumber} did not return an ETag`)
      uploaded.push({ partNumber, etag })
      sizeBytes += part.byteLength
    }

    if (!uploaded.length) throw new Error('Backup stream was empty')
    const completeUrl = new URL(objectUrl)
    completeUrl.searchParams.set('uploadId', uploadId)
    const body = `<CompleteMultipartUpload>${uploaded.map(part => (
      `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`
    )).join('')}</CompleteMultipartUpload>`
    const completeResponse = await requireOk(await request(completeUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    }), 'Multipart upload completion')
    const completeXml = await completeResponse.text()
    if (xmlValue(completeXml, 'Error')) throw new Error('S3 returned an error while completing the multipart upload')
    return { sizeBytes }
  }
  catch (error) {
    const abortUrl = new URL(objectUrl)
    abortUrl.searchParams.set('uploadId', uploadId)
    await request(abortUrl.toString(), { method: 'DELETE' }).catch(() => undefined)
    throw error
  }
}

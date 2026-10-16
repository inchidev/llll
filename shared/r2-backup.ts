type UploadedPart = { partNumber: number; etag: string }
type BackupBucket = { createMultipartUpload(key: string, options: { httpMetadata: { contentType: string } }): Promise<{
  uploadPart(partNumber: number, bytes: Uint8Array): Promise<UploadedPart>
  complete(parts: UploadedPart[]): Promise<unknown>
  abort(): Promise<void>
}> }
/** Bounded multipart upload: R2.put cannot accept an arbitrary-length stream. */
export async function uploadBackupToR2(bucket: BackupBucket, key: string, body: ReadableStream<Uint8Array>): Promise<{ sizeBytes: number }> {
  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/x-tar' } })
  const reader = body.getReader()
  const parts: UploadedPart[] = []
  const capacity = 8 * 1024 * 1024
  let buffer = new Uint8Array(capacity)
  let used = 0
  let sizeBytes = 0
  async function flush() {
    parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)))
    sizeBytes += used
    buffer = new Uint8Array(capacity)
    used = 0
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      let offset = 0
      while (offset < value.length) {
        const count = Math.min(capacity - used, value.length - offset)
        buffer.set(value.subarray(offset, offset + count), used)
        offset += count
        used += count
        if (used === capacity) await flush()
      }
    }
    if (used || !parts.length) await flush()
    await upload.complete(parts)
    return { sizeBytes }
  }
  catch (error) {
    await reader.cancel(error).catch(() => {})
    await upload.abort().catch(() => {})
    throw error
  }
  finally { reader.releaseLock() }
}

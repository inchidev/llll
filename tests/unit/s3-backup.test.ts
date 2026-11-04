import { describe, expect, it, vi } from 'vitest'
import type { BackupDestinationRuntimeConfig } from '../../server/utils/backup-destination'
import { backupObjectKey, s3ObjectUrl, testS3Destination, uploadBackupToS3 } from '../../server/utils/s3-backup'

function config(): BackupDestinationRuntimeConfig {
  return {
    endpoint: 'https://account.example.com/storage',
    region: 'auto',
    bucket: 'backup-bucket',
    prefix: 'llll/main',
    accessKeyId: 'access-key',
    secretAccessKey: 'secret-key',
    secretConfigured: true,
    secretReadable: true,
    lastBackupKey: null,
    lastBackupAt: null,
    lastBackupSizeBytes: null,
    updatedAt: null,
  }
}

function byteStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe('S3 backup destination', () => {
  it('builds a path-style object URL without losing an endpoint base path', () => {
    expect(s3ObjectUrl(config(), 'folder/a file.tar')).toBe(
      'https://account.example.com/storage/backup-bucket/folder/a%20file.tar',
    )
    expect(backupObjectKey('llll/main', '2026-09-05T10:20:30.000Z', 'v1/test')).toBe(
      'llll/main/llll-backup-2026-09-05T10-20-30Z-v1_test.tar',
    )
    expect(() => s3ObjectUrl(config(), '../backup.tar')).toThrow('cannot contain . or ..')
  })

  it('tests write and delete permissions using a temporary object', async () => {
    const methods: string[] = []
    await testS3Destination(config(), async (_url, init) => {
      methods.push(init?.method ?? 'GET')
      return new Response(null, { status: init?.method === 'PUT' ? 200 : 204 })
    })
    expect(methods).toEqual(['PUT', 'DELETE'])
  })

  it('signs destination requests without exposing the secret key', async () => {
    const requests: Request[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = input instanceof Request ? input : new Request(input)
      requests.push(request)
      return new Response(null, { status: request.method === 'PUT' ? 200 : 204 })
    })
    try {
      await testS3Destination(config())
      expect(requests).toHaveLength(2)
      expect(requests[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /u)
      expect(requests[0]!.headers.get('authorization')).not.toContain('secret-key')
      expect(requests[0]!.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/u)
    }
    finally {
      fetchMock.mockRestore()
    }
  })

  it('uploads a stream as ordered multipart parts and completes it', async () => {
    const fiveMiB = 5 * 1024 * 1024
    const partSizes: number[] = []
    let completion = ''
    const request = async (rawUrl: string, init?: RequestInit) => {
      const url = new URL(rawUrl)
      if (init?.method === 'POST' && url.searchParams.has('uploads')) {
        return new Response('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>')
      }
      if (init?.method === 'PUT') {
        partSizes.push((await new Response(init.body).arrayBuffer()).byteLength)
        return new Response(null, { headers: { etag: `"part-${partSizes.length}"` } })
      }
      if (init?.method === 'POST' && url.searchParams.has('uploadId')) {
        completion = await new Response(init.body).text()
        return new Response('<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>')
      }
      throw new Error(`Unexpected S3 request: ${init?.method} ${rawUrl}`)
    }
    const first = new Uint8Array(fiveMiB - 2)
    const second = new Uint8Array([1, 2, 3, 4, 5])

    const result = await uploadBackupToS3(config(), 'backup.tar', byteStream([first, second]), {
      request,
      partBytes: fiveMiB,
    })

    expect(result.sizeBytes).toBe(fiveMiB + 3)
    expect(partSizes).toEqual([fiveMiB, 3])
    expect(completion).toContain('<PartNumber>1</PartNumber><ETag>&quot;part-1&quot;</ETag>')
    expect(completion).toContain('<PartNumber>2</PartNumber><ETag>&quot;part-2&quot;</ETag>')
  })

  it('aborts the multipart upload when a part fails', async () => {
    const methods: string[] = []
    const request = async (rawUrl: string, init?: RequestInit) => {
      const url = new URL(rawUrl)
      methods.push(init?.method ?? 'GET')
      if (init?.method === 'POST' && url.searchParams.has('uploads')) {
        return new Response('<UploadId>upload-2</UploadId>')
      }
      if (init?.method === 'PUT') return new Response('denied', { status: 403 })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      throw new Error('Unexpected S3 request')
    }

    await expect(uploadBackupToS3(config(), 'backup.tar', byteStream([new Uint8Array([1])]), {
      request,
      partBytes: 5 * 1024 * 1024,
    })).rejects.toThrow('Multipart part 1 failed with S3 HTTP 403')
    expect(methods).toEqual(['POST', 'PUT', 'DELETE'])
  })
})

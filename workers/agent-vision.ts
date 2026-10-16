import type { FilePart, ModelMessage, UserModelMessage } from 'ai'

const MAX_IMAGE_COUNT = 4
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

const VISION_MODELS = new Set([
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/qwen/qwen3.8-27b',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/moonshotai/kimi-k2.6',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
])

type ImageAttachment = {
  r2Key: string
  filename: string
  contentType: string
  sizeBytes: number
}

export function agentModelSupportsVision(model: string): boolean {
  return VISION_MODELS.has(model)
}

export async function attachMessageImages(
  messages: ModelMessage[],
  db: D1Database,
  files: R2Bucket,
  messageId: string,
): Promise<ModelMessage[]> {
  const rows = await db.prepare(
    `SELECT r2_key as r2Key, filename, content_type as contentType, size_bytes as sizeBytes
     FROM attachments
     WHERE message_id = ? AND content_type LIKE 'image/%'
     ORDER BY created_at ASC
     LIMIT ?`,
  ).bind(messageId, MAX_IMAGE_COUNT).all<ImageAttachment>()

  const imageParts: FilePart[] = []
  let totalBytes = 0
  for (const row of rows.results ?? []) {
    if (row.sizeBytes > MAX_IMAGE_BYTES || totalBytes + row.sizeBytes > MAX_IMAGE_BYTES) continue
    const object = await files.get(row.r2Key)
    if (!object) continue
    const data = new Uint8Array(await object.arrayBuffer())
    if (totalBytes + data.byteLength > MAX_IMAGE_BYTES) continue
    totalBytes += data.byteLength
    imageParts.push({
      type: 'file',
      data: { type: 'data', data },
      filename: row.filename,
      mediaType: row.contentType,
    })
  }
  if (!imageParts.length) return messages

  const targetIndex = messages.findLastIndex(message => message.role === 'user')
  if (targetIndex < 0) return messages
  const target = messages[targetIndex] as UserModelMessage
  const content = typeof target.content === 'string'
    ? [{ type: 'text' as const, text: target.content }]
    : target.content
  const next = [...messages]
  next[targetIndex] = { ...target, content: [...content, ...imageParts] }
  return next
}

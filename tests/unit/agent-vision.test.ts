import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { agentModelSupportsVision, attachMessageImages } from '../../workers/agent-vision'

describe('agent vision', () => {
  it('recognizes the vision-capable agent models', () => {
    expect(agentModelSupportsVision('@cf/moonshotai/kimi-k2.7-code')).toBe(true)
    expect(agentModelSupportsVision('@cf/openai/gpt-oss-20b')).toBe(false)
  })

  it('adds R2 image bytes to the latest user model message', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [{
              r2Key: 'main/messages/image.png',
              filename: 'diagram.png',
              contentType: 'image/png',
              sizeBytes: 3,
            }],
          }),
        }),
      }),
    } as unknown as D1Database
    const files = {
      get: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
    } as unknown as R2Bucket
    const messages: ModelMessage[] = [{ role: 'user', content: 'What is this?' }]

    const result = await attachMessageImages(messages, db, files, 'message-1')

    expect(result).not.toBe(messages)
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        {
          type: 'file',
          data: { type: 'data', data: new Uint8Array([1, 2, 3]) },
          filename: 'diagram.png',
          mediaType: 'image/png',
        },
      ],
    })
  })
})

import { describe, expect, it } from 'vitest'
import { agentUserMessage, type AgentTurnMetadata } from '../../workers/agent-message'

describe('agent user message', () => {
  it('persists turn routing metadata for streaming lifecycle hooks', () => {
    const metadata: AgentTurnMetadata = {
      kind: 'message',
      submissionId: 'submission-1',
      sourceMessageId: 'message-1',
      channelId: 'channel-1',
      initiatedBy: 'user-1',
    }

    const message = agentUserMessage({
      id: 'message-1',
      authorName: 'Ada',
      content: 'Ship it',
      metadata,
    })

    expect(message.metadata).toEqual({ turnMetadata: metadata })
    expect(message.parts).toEqual([expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('Ship it'),
    })])
  })

  it('tells the agent when the workspace message includes images', () => {
    const metadata: AgentTurnMetadata = {
      kind: 'message',
      submissionId: 'submission-image',
      sourceMessageId: 'message-image',
      channelId: 'channel-1',
      initiatedBy: 'user-1',
      hasImages: true,
    }

    const message = agentUserMessage({
      id: 'message-image',
      authorName: 'Ada',
      content: '',
      metadata,
    })

    expect(message.parts).toEqual([expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('Inspect the visual input'),
    })])
  })
})

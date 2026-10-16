import type { UIMessage } from 'ai'

export type AgentTurnMetadata = {
  kind: 'message'
  submissionId: string
  sourceMessageId: string
  channelId: string
  initiatedBy: string
  hasImages?: boolean
}

export function agentUserMessage(input: {
  id: string
  authorName: string
  content: string
  metadata: AgentTurnMetadata
}): UIMessage {
  return {
    id: input.id,
    role: 'user',
    // Think submission metadata describes the queue record; lifecycle hooks
    // read turn metadata from the persisted user message instead.
    metadata: { turnMetadata: input.metadata },
    parts: [{
      type: 'text',
      text: [
        `${input.authorName} sent you this workspace message:`,
        input.content || '(No text)',
        input.metadata.hasImages ? 'The message includes one or more attached images. Inspect the visual input before responding.' : '',
        'Respond as a helpful workspace participant. Use tools when concrete work is requested. Keep the chat reply under 2000 characters.',
      ].filter(Boolean).join('\n\n'),
    }],
  }
}

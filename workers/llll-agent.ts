import { DurableObject } from 'cloudflare:workers'
import { createAgentRun } from '../server/utils/agent-run-service'
import { loadAuthorizationContext } from '../server/utils/authorization'
import type { L4Env } from './env'
import { ensureAgentReplyTarget } from './agent-replies'
import { readableMentions } from '../server/utils/member-names'
import { agentAttachmentTypes, agentImageLimit, agentImageMarker, agentImageMaxBytes, stripAgentImageMarkers } from '../shared/agent-images'

export type AgentMessageInput = {
  messageId: string
  channelId: string
  authorId: string
  authorName: string
  content: string
  hasImages?: boolean
  mode?: 'queue' | 'steer'
}


/** Coordinates authorized conversation-local agent runs. */
export class L4Agent extends DurableObject<L4Env> {
  private get agentId() {
    return (this.ctx.id.name ?? '').replace(/^agent:/u, '')
  }

  async receiveMessage(input: AgentMessageInput): Promise<string> {
    const actor = await loadAuthorizationContext(this.env, { principalId: input.authorId, credential: { kind: 'session' } })
    if (!actor) throw new Error('Invoking member unavailable')
    if (input.mode === 'steer' && this.env.AGENT_RUN_DO) {
      const active = await this.env.DB.prepare("SELECT id FROM agent_runs WHERE agent_id=? AND initiated_by=? AND (channel_id=? OR channel_id IN (SELECT id FROM channels WHERE parent_id=?)) AND status='running' ORDER BY created_at DESC LIMIT 1")
        .bind(this.agentId, input.authorId, input.channelId, input.channelId).first<{ id: string }>()
      if (active) {
        const run = this.env.AGENT_RUN_DO.getByName(`run:${active.id}`) as DurableObjectStub & { steer: (messageId: string, content: string, actorId: string) => Promise<boolean> }
        if (await run.steer(input.messageId, input.content, input.authorId)) return active.id
      }
    }
    const target = await ensureAgentReplyTarget(this.env.DB, input.channelId, input.messageId, { env: this.env, authorization: actor, schedule: promise => this.ctx.waitUntil(promise) })
    if (target.parentChannelId && target.parentMessageId) {
      const parent = this.env.CHANNEL_DO.getByName(`channel:${target.parentChannelId}`) as DurableObjectStub & { fanout: (event: unknown) => Promise<void> }
      await parent.fanout({ t: 'thread.created', messageId: target.parentMessageId, threadId: target.channelId })
    }
    const run = await createAgentRun(this.env, actor, { agentId: this.agentId, channelId: target.channelId, prompt: await this.prompt(input),
      sourceMessageId: input.messageId, idempotencyKey: input.messageId })
    return run.id
  }

  /** The model reads mentions as names, as people do; a bare mention is a ping, not an empty request. */
  private async prompt(input: AgentMessageInput): Promise<string> {
    const content = stripAgentImageMarkers(input.content)
    const images = input.hasImages ? await this.images(input) : ''
    if (!content.replace(new RegExp(`<@${this.agentId}>`, 'giu'), '').trim()) {
      return images
        ? `${input.authorName} sent an attachment without text: an image to describe or a voice message to answer. Respond to it and ask what they need if it is unclear.\n${images}`
        : `${input.authorName} mentioned you without any other text. Reply briefly and ask what they need.`
    }
    return (await readableMentions(this.env, [content]))[0]! + (images ? `\n${images}` : '')
  }

  /** References to the author's own images on this message; the gateway loads and rechecks them. */
  private async images(input: AgentMessageInput): Promise<string> {
    const rows = await this.env.DB.prepare(`SELECT id FROM attachments WHERE message_id=? AND uploader_id=? AND size_bytes<=?
      AND content_type IN (${agentAttachmentTypes.map(() => '?').join(',')}) ORDER BY created_at,id LIMIT ?`)
      .bind(input.messageId, input.authorId, agentImageMaxBytes, ...agentAttachmentTypes, agentImageLimit).all<{ id: string }>()
    return rows.results.map(row => agentImageMarker(row.id)).join('\n')
  }

  async controlConversation(input: {
    channelId: string
    action: 'stop' | 'approve' | 'reject'
    executionId?: string
  }): Promise<void> {
    if (input.action === 'stop' && this.env.AGENT_RUN_DO) {
      const pending = await this.env.DB.prepare(`SELECT id FROM agent_runs WHERE agent_id=? AND (channel_id=? OR channel_id IN (SELECT id FROM channels WHERE parent_id=?)) AND status IN ('queued','running') ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END,created_at`)
        .bind(this.agentId, input.channelId, input.channelId).all<{ id: string }>()
      if (pending.results.length) {
        for (const run of pending.results) await (this.env.AGENT_RUN_DO.getByName(`run:${run.id}`) as DurableObjectStub & { cancel: () => Promise<void> }).cancel()
        return
      }
    }
    if (input.action !== 'stop') throw new Error('This action is unavailable for the current execution')
  }
}

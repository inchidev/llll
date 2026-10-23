import { Agent } from 'agents'
import { createAgentRun } from '../server/utils/agent-run-service'
import { loadAuthorizationContext } from '../server/utils/authorization'
import type { L4Env } from './env'
import { ensureAgentReplyTarget } from './agent-replies'

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
export class L4Agent extends Agent<L4Env> {
  async receiveMessage(input: AgentMessageInput): Promise<string> {
    const actor = await loadAuthorizationContext(this.env, { principalId: input.authorId, credential: { kind: 'session' } })
    if (!actor) throw new Error('Invoking member unavailable')
    if (input.mode === 'steer' && this.env.AGENT_RUN_DO) {
      const active = await this.env.DB.prepare("SELECT id FROM agent_runs WHERE agent_id=? AND initiated_by=? AND (channel_id=? OR channel_id IN (SELECT id FROM channels WHERE parent_id=?)) AND status='running' ORDER BY created_at DESC LIMIT 1")
        .bind(this.name.replace(/^agent:/u, ''), input.authorId, input.channelId, input.channelId).first<{ id: string }>()
      if (active) {
        const run = this.env.AGENT_RUN_DO.getByName(`run:${active.id}`) as DurableObjectStub & { steer: (messageId: string, content: string, actorId: string) => Promise<boolean> }
        if (await run.steer(input.messageId, input.content, input.authorId)) return active.id
      }
    }
    const target = await ensureAgentReplyTarget(this.env.DB, input.channelId, input.messageId)
    if (target.parentChannelId && target.parentMessageId) {
      const parent = this.env.CHANNEL_DO.getByName(`channel:${target.parentChannelId}`) as DurableObjectStub & { fanout: (event: unknown) => Promise<void> }
      await parent.fanout({ t: 'thread.created', messageId: target.parentMessageId, threadId: target.channelId })
    }
    const run = await createAgentRun(this.env, actor, { agentId: this.name.replace(/^agent:/u, ''), channelId: target.channelId, prompt: input.content || 'The user attached an image. Visual input is unavailable in this runtime; explain that limitation without claiming to inspect it.',
      sourceMessageId: input.messageId, idempotencyKey: input.messageId })
    return run.id
  }

  async controlConversation(input: {
    channelId: string
    action: 'stop' | 'approve' | 'reject'
    executionId?: string
  }): Promise<void> {
    if (input.action === 'stop' && this.env.AGENT_RUN_DO) {
      const pending = await this.env.DB.prepare(`SELECT id FROM agent_runs WHERE agent_id=? AND (channel_id=? OR channel_id IN (SELECT id FROM channels WHERE parent_id=?)) AND status IN ('queued','running') ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END,created_at`)
        .bind(this.name.replace(/^agent:/u, ''), input.channelId, input.channelId).all<{ id: string }>()
      if (pending.results.length) {
        for (const run of pending.results) await (this.env.AGENT_RUN_DO.getByName(`run:${run.id}`) as DurableObjectStub & { cancel: () => Promise<void> }).cancel()
        return
      }
    }
    if (input.action !== 'stop') throw new Error('This action is unavailable for the current execution')
  }
}

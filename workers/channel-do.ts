import { authorizedPublicationMessage } from '../server/utils/run-publication'
import { retryDeletedFiles } from '../shared/file-cleanup'
import { messageDeleteRole, messageSendRate, removeChannelMessage, takeRate } from '../server/utils/message-service'
import { parseResourceAccess, resourceAccessAllows } from '../shared/resource-access'
import { getServerId } from '../shared/server-id'
import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import type { AttachmentDTO, LiveState, MessageDTO, PublicUser, ServerMsg } from '../shared/types'
import { extractMentionIds } from '../shared/mentions'
import { canAccessAgentConversation, isDmType } from '../shared/dm'
import { ALL_PERMISSIONS, directMessagePermissions, hasPermission, Permission } from '../shared/permissions'
import { liveKindFor } from '../shared/live'
import { resolveChannelPermissions } from '../shared/channel-permissions'
import { newId, nowIso } from '../shared/ids'
import { asRpc, callsProvider, type L4Env } from './env'
import type { RealtimeKitParticipant } from './realtimekit'
import { liveMedia } from './live-media'
import { sessionFromTicket, socketSessionActive } from './ticket'
import { channelHasUnread } from './unread'
import { liveNotificationStatement, messageNotificationStatement, signalNotificationOutbox } from './notifications'
import { signalLiveChanged } from './live-events'
import {
  emptyLive,
  isLiveHost,
  LIVE_PRESENCE_TTL_MS,
  LIVE_RING_TIMEOUT_MS,
  liveFailure,
  liveGraceMs,
  normalizeLive,
  type LiveEndResult,
  type LiveJoinResult,
} from './live-room'
import { signalChannelActivity, signalChannelRead } from './channel-activity'
import { signalAgentsForMessage } from './agent-ingress'
import { listAgentTurns } from './agent-turns'
import { AGENT_REACTION_EMOJIS, replaceAgentReaction } from './agent-reactions'
import { mailPermissionAllows } from '../shared/mail'
import { createSerialQueue } from './serial-queue'
import { authorizedSockets } from './socket-access'

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000

type Sock = { userId: string; user: PublicUser; sessionId?: string }
type Authz = { serverId: string; perms: number; ownerId: string; type: string; frozen: boolean; canManageAgents: boolean; mailbox: boolean }

const createSchema = z.object({
  t: z.literal('message.create'),
  content: z.string().max(2000),
  replyToId: z.string().min(8).optional(),
  clientId: z.string().min(1).max(80),
  attachmentIds: z.array(z.string().min(8)).max(8).optional(),
  agentMode: z.enum(['queue', 'steer']).optional(),
})

const agentControlSchema = z.object({
  t: z.literal('agent.control'),
  agentId: z.string().min(8),
  action: z.enum(['stop', 'approve', 'reject']),
  executionId: z.string().min(1).optional(),
})

const updateSchema = z.object({
  t: z.literal('message.update'),
  id: z.string().min(8),
  content: z.string().min(1).max(2000),
})

const agentPostSchema = z.object({
  sourceRunId: z.string().uuid().optional(),
  sourcePublicationId: z.string().uuid().optional(),
  agentId: z.string().min(8),
  content: z.string().trim().min(1).max(2000),
})

const agentUpdateSchema = agentPostSchema.extend({
  messageId: z.string().min(8),
})

const agentReactionSchema = z.object({
  agentId: z.string().min(8),
  messageId: z.string().min(8),
  emoji: z.enum(AGENT_REACTION_EMOJIS),
})

export class ChannelDurableObject extends DurableObject<L4Env> {
  private readonly inOrder = createSerialQueue()
  private readonly liveInOrder = createSerialQueue()

  constructor(ctx: DurableObjectState, env: L4Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const url = new URL(request.url)
    const parts = url.pathname.split('/')
    const channelId = parts[parts.length - 1] || this.channelId()
    await this.ctx.storage.put('channelId', channelId)

    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    this.ctx.waitUntil(this.authTimeout(pair[1]))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return
    let msg: { t?: string; token?: string; clientId?: string }
    try {
      msg = JSON.parse(raw) as { t?: string; token?: string; clientId?: string }
    }
    catch {
      this.send(ws, { t: 'error', code: 'bad_json', message: 'Invalid JSON' })
      return
    }

    const sock = ws.deserializeAttachment() as Sock | null
    if (msg.t === 'auth' && typeof msg.token === 'string') {
      const session = await sessionFromTicket(this.env, msg.token)
      if (!session) {
        this.send(ws, { t: 'error', code: 'unauthorized', message: 'Invalid session' })
        ws.close(4001, 'unauthorized')
        return
      }
      await this.hello(ws, session.user, session.sessionId)
      return
    }
    if (!sock?.userId) {
      this.send(ws, { t: 'error', code: 'unauthorized', message: 'Auth required' })
      return
    }

    try {
      // New messages are handled strictly in arrival order. Their D1 writes
      // otherwise interleave, and a quick second message could be stored first.
      if (msg.t === 'message.create') await this.inOrder(() => this.handle(ws, sock, raw))
      else await this.handle(ws, sock, raw)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : 'error'
      this.send(ws, {
        t: 'error',
        code: 'internal',
        message,
        ...(msg.t === 'message.create' && msg.clientId ? { clientId: msg.clientId } : {}),
      })
    }
  }

  override async webSocketClose(_ws: WebSocket): Promise<void> {
    // Chat navigation closes this socket while RealtimeKit media stays joined.
    // Live presence changes only through the Live API and its heartbeats.
  }

  override async alarm(): Promise<void> {
    await this.liveInOrder(() => this.liveAlarm())
  }

  /** Admission is rechecked even for idle, hibernating sockets after a membership change. */
  async revalidateAccess(): Promise<void> {
    await authorizedSockets(this.ctx.getWebSockets(), async (userId, session) => {
      if (!await socketSessionActive(this.env, session)) return false
      const authz = await this.loadAuthz(userId)
      return Boolean(authz && !authz.frozen)
    })
    await this.revalidateLive()
  }

  async fanout(msg: ServerMsg): Promise<void> {
    if (msg.t === 'agent.state') {
      for (const ws of await authorizedSockets(this.ctx.getWebSockets(), (_id, session) => socketSessionActive(this.env, session))) {
        const sock = ws.deserializeAttachment() as Sock | null
        if (!sock?.userId) continue
        const authz = await this.loadAuthz(sock.userId)
        if (authz?.canManageAgents) this.send(ws, msg)
      }
      return
    }
    await this.broadcast(msg)
  }

  async postAgentMessage(input: z.infer<typeof agentPostSchema>): Promise<{ id: string, channelId: string }> {
    const body = agentPostSchema.parse(input)
    const authz = await this.loadAuthz(body.agentId)
    if (!authz || !hasPermission(authz.perms, Permission.sendMessages)) {
      throw new Error('Agent cannot send messages in this channel')
    }
    const agent = await this.env.DB.prepare(
      `SELECT u.id, u.kind, u.display_name as displayName, u.avatar_r2_key as avatarR2Key, r.permissions_bitmask as permissions
       FROM users u JOIN agents a ON a.user_id = u.id JOIN roles r ON r.id=u.role_id
       WHERE u.id = ? AND u.kind = 'agent' AND u.status = 'active' AND a.status = 'active'`,
    ).bind(body.agentId).first<{
      id: string
      kind: 'agent'
      displayName: string
      avatarR2Key: string | null
      permissions: number
    }>()
    if (!agent) throw new Error('Agent is unavailable')

    const channel = await this.env.DB.prepare(
      'SELECT id, type, visibility, parent_id as parentId FROM channels WHERE id = ?',
    ).bind(this.channelId()).first<{ id: string; type: string; visibility: string; parentId: string | null }>()
    if (!channel) throw new Error('Channel not found')
    const accessChannelId = channel.type === 'thread' && channel.parentId ? channel.parentId : channel.id
    if (channel.visibility === 'private') {
      const access = await this.env.DB.prepare(
        'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?',
      ).bind(accessChannelId, agent.id).first()
      if (!access) throw new Error('Agent cannot access this private channel')
    }
    const mailbox = await this.env.DB.prepare(
      `SELECT mb.enabled, a.permission
       FROM email_mailboxes mb
       LEFT JOIN email_mailbox_access a ON a.channel_id = mb.channel_id AND a.user_id = ?
       WHERE mb.channel_id = ?`,
    ).bind(agent.id, accessChannelId).first<{ enabled: number; permission: 'read' | 'send' | 'manage' | null }>()
    if (mailbox && (!mailbox.enabled || !mailbox.permission || !mailPermissionAllows(mailbox.permission, 'send') || !hasPermission(agent.permissions, Permission.sendMail))) {
      throw new Error('Agent cannot send in this mailbox')
    }

    if (body.sourceRunId && body.sourcePublicationId) throw new Error('Ambiguous publication identity')
    let id = newId()
    if (body.sourcePublicationId) {
      id = await authorizedPublicationMessage(this.env, channel.id, { ...body, sourcePublicationId: body.sourcePublicationId })
      const previous = await this.env.DB.prepare('SELECT id FROM messages WHERE id=? AND channel_id=? AND author_id=?').bind(id, channel.id, agent.id).first()
      if (previous) return { id, channelId: channel.id }
    }
    if (body.sourceRunId) {
      const run = await this.env.DB.prepare("SELECT result_message_id as messageId FROM agent_runs WHERE id=? AND agent_id=? AND channel_id=? AND status IN ('completed','failed')")
        .bind(body.sourceRunId, body.agentId, channel.id).first<{ messageId: string }>()
      if (!run?.messageId) throw new Error('Finished Run not found')
      id = run.messageId
      const previous = await this.env.DB.prepare('SELECT id FROM messages WHERE id=? AND channel_id=? AND author_id=?').bind(id, channel.id, agent.id).first()
      if (previous) return { id, channelId: channel.id }
    }
    const createdAt = nowIso()
    const message: MessageDTO = {
      id,
      channelId: channel.id,
      serverId: (await getServerId(this.env.DB)),
      author: agent,
      content: body.content,
      replyTo: null,
      mentions: [],
      attachments: [],
      reactions: [],
      pin: null,
      threadId: null,
      editedAt: null,
      deletedAt: null,
      createdAt,
    }
    await this.persistMessage(message, null)
    this.ctx.waitUntil(signalNotificationOutbox(this.env))
    // A reply inside a thread must refresh the parent conversation's thread list.
    if (channel.type === 'thread' && channel.parentId) {
      const threadChannel = await this.env.DB.prepare('SELECT parent_message_id as parentMessageId FROM channels WHERE id=?')
        .bind(channel.id).first<{ parentMessageId: string | null }>()
      if (threadChannel?.parentMessageId) {
        const parent = this.env.CHANNEL_DO.getByName(`channel:${channel.parentId}`) as DurableObjectStub & {
          fanout: (value: unknown) => Promise<void>
        }
        this.ctx.waitUntil(parent.fanout({ t: 'thread.created', messageId: threadChannel.parentMessageId, threadId: channel.id }).catch(() => undefined))
      }
    }
    this.ctx.waitUntil(signalChannelActivity(this.env, {
      id,
      channelId: channel.id,
      author: agent,
      content: body.content,
      attachmentCount: 0,
    }))
    await this.broadcast({ t: 'message', message })
    return { id, channelId: channel.id }
  }

  async updateAgentMessage(input: z.infer<typeof agentUpdateSchema>): Promise<void> {
    const body = agentUpdateSchema.parse(input)
    const authz = await this.loadAuthz(body.agentId)
    if (!authz || !hasPermission(authz.perms, Permission.sendMessages)) throw new Error('Agent cannot edit in this channel')
    const row = await this.env.DB.prepare(
      `SELECT m.id
       FROM messages m
       JOIN users u ON u.id = m.author_id
       JOIN agents a ON a.user_id = u.id
       WHERE m.id = ? AND m.channel_id = ? AND m.author_id = ?
         AND m.deleted_at IS NULL AND u.kind = 'agent'`,
    ).bind(body.messageId, this.channelId(), body.agentId).first<{ id: string }>()
    if (!row) throw new Error('Agent message not found')
    await this.env.DB.prepare('UPDATE messages SET content = ? WHERE id = ?').bind(body.content, body.messageId).run()
    const message = await this.loadMessage(body.messageId)
    if (message) await this.broadcast({ t: 'message.update', message, streaming: true })
  }

  async setAgentReaction(input: z.infer<typeof agentReactionSchema>): Promise<void> {
    const body = agentReactionSchema.parse(input)
    const authz = await this.loadAuthz(body.agentId)
    if (!authz || !hasPermission(authz.perms, Permission.sendMessages)) throw new Error('Agent cannot react in this channel')
    const target = await this.env.DB.prepare(
      `SELECT m.id
       FROM messages m
       JOIN users u ON u.id = ?
       JOIN agents a ON a.user_id = u.id
       WHERE m.id = ? AND m.channel_id = ?
         AND u.kind = 'agent' AND u.status = 'active' AND a.status = 'active'`,
    ).bind(body.agentId, body.messageId, this.channelId()).first<{ id: string }>()
    if (!target) throw new Error('Agent reaction target not found')

    const change = await replaceAgentReaction(this.env.DB, body.messageId, body.agentId, body.emoji)
    for (const emoji of change.removed) {
      await this.broadcast({ t: 'reaction', messageId: body.messageId, emoji, userId: body.agentId, op: 'remove' })
    }
    if (change.added) {
      await this.broadcast({ t: 'reaction', messageId: body.messageId, emoji: change.added, userId: body.agentId, op: 'add' })
    }
  }

  // The conversation's Live room. Every change runs through `liveInOrder`, so
  // two people starting at once share one meeting.

  async getLive(): Promise<LiveState> {
    return normalizeLive(await this.ctx.storage.get('live'))
  }

  /** Join the room, starting it first when it is idle and the member may start one. */
  async joinLive(user: PublicUser): Promise<LiveJoinResult> {
    return this.liveInOrder(() => this.joinLiveNow(user))
  }

  async leaveLive(userId: string): Promise<LiveState> {
    return this.liveInOrder(() => this.leaveLiveNow(userId))
  }

  /** The other person turns down a ringing Call. */
  async declineLive(userId: string): Promise<LiveState> {
    return this.liveInOrder(async () => {
      const live = await this.getLive()
      if (!live.active || live.kind !== 'call' || !live.ringing || live.startedBy === userId) return live
      return this.endLiveNow({ outcome: 'declined' })
    })
  }

  /** End the room for everyone. Only hosts may. */
  async endLive(userId: string): Promise<LiveEndResult> {
    return this.liveInOrder(async () => {
      const live = await this.getLive()
      if (!live.active) return liveFailure('not_found', 'No live session to end')
      const authz = await this.loadAuthz(userId)
      if (!authz || !isLiveHost(live, userId, { directMessage: isDmType(authz.type), perms: authz.perms })) {
        return liveFailure('forbidden', 'Only the person who started it or a channel manager can end this live session')
      }
      return { ok: true as const, live: await this.endLiveNow({}) }
    })
  }

  /** Keep a joined participant present. False when they are no longer in the room. */
  async pingLive(userId: string): Promise<boolean> {
    return this.liveInOrder(async () => {
      const live = await this.getLive()
      const seats = await this.liveSeats()
      if (!live.active || !seats[userId]) return false
      const presence = await this.livePresence()
      presence[userId] = Date.now() + LIVE_PRESENCE_TTL_MS
      await this.ctx.storage.put('livePresence', presence)
      if (!live.participantIds.includes(userId)) {
        // A slow heartbeat expired them without them leaving; they are still here.
        live.participantIds.push(userId)
        await this.ctx.storage.delete('liveCleanupAt')
        await this.setLive(live)
        this.publishLive(live)
      }
      await this.refreshAlarm()
      return true
    })
  }

  /**
   * Re-check who may stay after access changed: a removed member, someone taken
   * off a private Channel or group Direct Message, or a deleted conversation.
   * Whoever lost access leaves the media session and their token is revoked.
   */
  async revalidateLive(): Promise<void> {
    await this.liveInOrder(async () => {
      const live = await this.getLive()
      if (!live.active || !live.meetingId) return
      const exists = await this.env.DB.prepare('SELECT id FROM channels WHERE id = ?').bind(this.channelId()).first()
      if (!exists) {
        await this.endLiveNow({})
        return
      }
      const seats = await this.liveSeats()
      const revoked: string[] = []
      for (const userId of Object.keys(seats)) {
        const authz = await this.loadAuthz(userId)
        if (!authz || authz.frozen || authz.mailbox) revoked.push(userId)
      }
      if (!revoked.length) return
      if (live.kind === 'call') {
        await this.endLiveNow({})
        return
      }
      await (await liveMedia(this.env))?.removeParticipants(live.meetingId, revoked.map(id => seats[id]!.participantId))
      const keep = ([userId]: [string, unknown]) => !revoked.includes(userId)
      const presence = Object.fromEntries(Object.entries(await this.livePresence()).filter(keep))
      live.participantIds = live.participantIds.filter(id => !revoked.includes(id))
      await this.ctx.storage.put({ livePresence: presence, liveSeats: Object.fromEntries(Object.entries(seats).filter(keep)) })
      if (!live.participantIds.length) await this.scheduleCleanup(liveGraceMs(live.kind, await this.isDirectMessage()))
      await this.setLive(live)
      await this.refreshAlarm()
      this.publishLive(live)
    })
  }

  private async handle(ws: WebSocket, sock: Sock, raw: string) {
    if (!await socketSessionActive(this.env, sock)) {
      ws.close(4403, 'session_revoked')
      return
    }
    const parsed = JSON.parse(raw) as { t: string }
    const authz = await this.loadAuthz(sock.userId)
    if (!authz) {
      this.send(ws, { t: 'error', code: 'not_found', message: 'Channel not found' })
      return
    }

    switch (parsed.t) {
      case 'message.create':
        await this.onCreate(ws, sock, authz, createSchema.parse(JSON.parse(raw)))
        break
      case 'message.update':
        await this.onUpdate(ws, sock, authz, updateSchema.parse(JSON.parse(raw)))
        break
      case 'message.delete':
        await this.onDelete(ws, sock, authz, (JSON.parse(raw) as { id: string }).id)
        break
      case 'agent.control':
        await this.onAgentControl(ws, sock, authz, agentControlSchema.parse(JSON.parse(raw)))
        break
      case 'typing':
        await this.broadcast({
          t: 'typing',
          userId: sock.userId,
          active: (JSON.parse(raw) as { active?: boolean }).active !== false,
        }, ws)
        break
      case 'read':
        await this.onRead(sock, authz, (JSON.parse(raw) as { messageId: string }).messageId)
        break
      default:
        this.send(ws, { t: 'error', code: 'unknown', message: `Unknown type ${parsed.t}` })
    }
  }

  private async onCreate(
    ws: WebSocket,
    sock: Sock,
    authz: Authz,
    body: z.infer<typeof createSchema>,
  ) {
    const fail = (code: string, message: string) => this.send(ws, {
      t: 'error',
      code,
      message,
      clientId: body.clientId,
    })
    if (authz.frozen) {
      fail('frozen', 'You can no longer send messages to this user')
      return
    }
    if (!hasPermission(authz.perms, Permission.sendMessages)) {
      fail('forbidden', 'Cannot send messages in this channel')
      return
    }
    if (body.attachmentIds?.length && !hasPermission(authz.perms, Permission.attachFiles)) {
      fail('forbidden', 'Cannot attach files in this channel')
      return
    }
    if (!body.content.trim() && !(body.attachmentIds?.length)) {
      fail('bad_request', 'Empty message')
      return
    }
    const idemKey = `idem:${sock.userId}:${body.clientId}`
    const existing = await this.ctx.storage.get<{ id: string; at: number } | string>(idemKey)
    const existingId = typeof existing === 'string' ? existing : existing && Date.now() - existing.at < IDEMPOTENCY_TTL_MS ? existing.id : null
    if (existingId) {
      this.send(ws, { t: 'ack', clientId: body.clientId, id: existingId })
      return
    }
    if (!await takeRate(this.env, messageSendRate(sock.userId))) {
      fail('rate_limited', 'Slow down')
      return
    }

    const id = newId()
    const createdAt = nowIso()
    const mentions = await this.validMentions(extractMentionIds(body.content))
    const attachmentIds = [...new Set(body.attachmentIds ?? [])]
    if (attachmentIds.length !== (body.attachmentIds?.length ?? 0)) {
      fail('bad_request', 'Duplicate attachment')
      return
    }
    const attachments = await this.loadAttachments(sock.userId, attachmentIds)
    if (attachments.length !== attachmentIds.length) {
      fail('bad_request', 'Invalid attachment')
      return
    }
    let replyTo: MessageDTO['replyTo'] = null
    if (body.replyToId) {
      const row = await this.env.DB.prepare(
        `SELECT id, author_id, content, deleted_at,
          (SELECT COUNT(*) FROM attachments WHERE message_id = messages.id) AS attachment_count
         FROM messages WHERE id = ? AND channel_id = ?`,
      ).bind(body.replyToId, this.channelId()).first<{
        id: string
        author_id: string
        content: string
        deleted_at: string | null
        attachment_count: number
      }>()
      if (!row) {
        fail('bad_request', 'Invalid reply target')
        return
      }
      replyTo = {
        id: row.id,
        authorId: row.author_id,
        content: row.deleted_at ? '' : row.content.slice(0, 180),
        attachmentCount: row.attachment_count,
        deleted: Boolean(row.deleted_at),
      }
    }

    const dto: MessageDTO = {
      id,
      channelId: this.channelId(),
      serverId: authz.serverId,
      author: sock.user,
      content: body.content,
      replyTo,
      mentions,
      attachments,
      reactions: [],
      pin: null,
      threadId: null,
      editedAt: null,
      deletedAt: null,
      createdAt,
      clientId: body.clientId,
    }

    await this.persistMessage(dto, body.replyToId ?? null)
    this.ctx.waitUntil(signalNotificationOutbox(this.env))
    this.ctx.waitUntil(signalChannelActivity(this.env, {
      id,
      channelId: this.channelId(),
      author: sock.user,
      content: body.content,
      attachmentCount: attachments.length,
    }))
    this.ctx.waitUntil(signalChannelRead(this.env, sock.userId, this.channelId(), id))
    await this.ctx.storage.put(idemKey, { id, at: Date.now() })
    await this.pruneIdempotency()
    await this.broadcast({ t: 'message', message: dto })
    this.send(ws, { t: 'ack', clientId: body.clientId, id })
    this.ctx.waitUntil(signalAgentsForMessage(this.env, {
      messageId: id,
      channelId: this.channelId(),
      authorId: sock.userId,
      authorName: sock.user.displayName,
      content: body.content,
      mentionIds: mentions,
      mode: body.agentMode,
    }))
  }

  private async onAgentControl(
    ws: WebSocket,
    sock: Sock,
    authz: Authz,
    body: z.infer<typeof agentControlSchema>,
  ) {
    if (!authz.canManageAgents) {
      this.send(ws, { t: 'error', code: 'forbidden', message: 'Cannot control an Agent in this channel' })
      return
    }
    if (body.action !== 'stop') {
      const actor = await this.env.DB.prepare(
        `SELECT r.permissions_bitmask as permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.status = 'active'`,
      ).bind(sock.user.id).first<{ permissions: number }>()
      if (sock.user.id !== authz.ownerId && (!actor || !hasPermission(actor.permissions, Permission.approveAgentActions))) {
        this.send(ws, { t: 'error', code: 'forbidden', message: 'Cannot approve Agent actions' })
        return
      }
    }
    const turn = await this.env.DB.prepare(
      `SELECT submission_id FROM agent_turns
       WHERE channel_id = ? AND agent_id = ?
         AND (? IS NULL OR approval_json LIKE ?)
       LIMIT 1`,
    ).bind(this.channelId(), body.agentId, body.executionId ?? null, body.executionId ? `%${body.executionId}%` : null).first<{ submission_id: string }>()
    if (!turn) {
      this.send(ws, { t: 'error', code: 'not_found', message: 'Agent run not found' })
      return
    }
    if (body.action === 'stop' && this.env.AGENT_RUN_DO) {
      const run = await this.env.DB.prepare("SELECT id,initiated_by as initiatedBy FROM agent_runs WHERE id=? AND channel_id=? AND agent_id=? AND status IN ('queued','running')")
        .bind(turn.submission_id, this.channelId(), body.agentId).first<{ id: string; initiatedBy: string }>()
      if (run) {
        if (sock.user.id !== run.initiatedBy && sock.user.id !== authz.ownerId && !hasPermission(authz.perms, Permission.manageAgents)) {
          this.send(ws, { t: 'error', code: 'forbidden', message: 'Cannot stop this run' }); return
        }
        await asRpc<{ cancel: () => Promise<void> }>(this.env.AGENT_RUN_DO.getByName(`run:${run.id}`)).cancel()
        return
      }
    }
    const agent = asRpc<{
      controlConversation: (input: { channelId: string; action: 'stop' | 'approve' | 'reject'; executionId?: string }) => Promise<void>
    }>(this.env.AGENT_DO.getByName(`agent:${body.agentId}`))
    await agent.controlConversation({ channelId: this.channelId(), action: body.action, executionId: body.executionId })
  }

  private async onUpdate(ws: WebSocket, sock: Sock, authz: Authz, body: z.infer<typeof updateSchema>) {
    if (!hasPermission(authz.perms, Permission.sendMessages)) {
      this.send(ws, { t: 'error', code: 'forbidden', message: 'Cannot edit messages in this channel' })
      return
    }
    const row = await this.env.DB.prepare(
      'SELECT id, author_id, channel_id, content, reply_to_id, created_at, deleted_at FROM messages WHERE id = ?',
    ).bind(body.id).first<{
      id: string
      author_id: string
      channel_id: string
      content: string
      reply_to_id: string | null
      created_at: string
      deleted_at: string | null
    }>()
    if (!row || row.channel_id !== this.channelId()) {
      this.send(ws, { t: 'error', code: 'not_found', message: 'Message not found' })
      return
    }
    if (row.author_id !== sock.userId) {
      this.send(ws, { t: 'error', code: 'forbidden', message: 'Not your message' })
      return
    }
    if (row.deleted_at) return
    const editedAt = nowIso()
    const mentions = await this.validMentions(extractMentionIds(body.content))
    await this.env.DB.batch([
      this.env.DB.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').bind(body.content, editedAt, body.id),
      this.env.DB.prepare('DELETE FROM message_mentions WHERE message_id = ?').bind(body.id),
      ...mentions.map((userId) => this.env.DB.prepare(
        'INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)',
      ).bind(body.id, userId)),
    ])
    const dto = await this.loadMessage(body.id)
    if (dto) await this.broadcast({ t: 'message.update', message: dto })
  }

  private async onDelete(ws: WebSocket, sock: Sock, authz: Authz, id: string) {
    const row = await this.env.DB.prepare(
      'SELECT author_id, channel_id, deleted_at FROM messages WHERE id = ?',
    ).bind(id).first<{ author_id: string; channel_id: string; deleted_at: string | null }>()
    if (!row || row.channel_id !== this.channelId()) {
      this.send(ws, { t: 'error', code: 'not_found', message: 'Message not found' })
      return
    }
    const role = messageDeleteRole(row.author_id, sock.userId, { perms: authz.perms, mailbox: authz.mailbox })
    if (!role) {
      this.send(ws, { t: 'error', code: 'forbidden', message: 'Not your message' })
      return
    }
    if (row.deleted_at) return
    const pinned = await removeChannelMessage(this.env, { id, channelId: row.channel_id, authorId: row.author_id, actorId: sock.userId,
      serverId: authz.serverId, moderator: role === 'moderator' })
    this.ctx.waitUntil(retryDeletedFiles(this.env))
    await this.broadcast({ t: 'message.delete', id })
    if (pinned) await this.broadcast({ t: 'pin', messageId: id, pin: null })
  }

  /** Sweeps a bounded slice of idempotency keys per send, so old keys expire without a scan. */
  private async pruneIdempotency() {
    const cursor = await this.ctx.storage.get<string>('idemCursor')
    const page = await this.ctx.storage.list<{ id: string; at: number } | string>({ prefix: 'idem:', ...(cursor ? { startAfter: cursor } : {}), limit: 32 })
    const now = Date.now()
    const expired = [...page].filter(([, value]) => typeof value !== 'object' || now - value.at >= IDEMPOTENCY_TTL_MS).map(([key]) => key)
    if (expired.length) await this.ctx.storage.delete(expired)
    const last = [...page.keys()].at(-1)
    if (page.size < 32 || !last) await this.ctx.storage.delete('idemCursor')
    else await this.ctx.storage.put('idemCursor', last)
  }

  private async onRead(sock: Sock, _authz: Authz, messageId: string) {
    const message = await this.env.DB.prepare(
      'SELECT id FROM messages WHERE id = ? AND channel_id = ?',
    ).bind(messageId, this.channelId()).first<{ id: string }>()
    if (!message) return
    await this.env.DB.prepare(
      `INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id, user_id) DO UPDATE
       SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
       WHERE channel_reads.last_read_message_id IS NULL
          OR channel_reads.last_read_message_id < excluded.last_read_message_id`,
    ).bind(this.channelId(), sock.userId, messageId, nowIso()).run()
    const state = await this.env.DB.prepare(
      `SELECT last_read_message_id
       FROM channel_reads
       WHERE channel_id = ? AND user_id = ?`,
    ).bind(this.channelId(), sock.userId).first<{
      last_read_message_id: string | null
    }>()
    const cursor = state?.last_read_message_id ?? messageId
    await this.sendToUser(sock.userId, {
      t: 'read.ack',
      channelId: this.channelId(),
      messageId: cursor,
      unread: await channelHasUnread(this.env.DB, sock.userId, this.channelId()),
    })
    this.ctx.waitUntil(signalChannelRead(this.env, sock.userId, this.channelId(), cursor))
  }

  private async joinLiveNow(user: PublicUser): Promise<LiveJoinResult> {
    const authz = await this.loadAuthz(user.id)
    if (!authz) return liveFailure('not_found', 'Conversation not found')
    if (authz.mailbox) return liveFailure('forbidden', 'Live sessions are unavailable for mailboxes')
    if (authz.type === 'thread') return liveFailure('forbidden', 'Join the live session in the parent conversation')
    if (authz.frozen) return liveFailure('frozen', 'You can no longer call in this Direct Message')
    if (!callsProvider(this.env)) {
      return liveFailure('calls_unavailable', 'Calls use Cloudflare RealtimeKit and are unavailable on this runtime')
    }
    const media = await liveMedia(this.env)
    if (!media) return liveFailure('realtimekit_unconfigured', 'Live needs RealtimeKit')

    const directMessage = isDmType(authz.type)
    let live = await this.getLive()
    const starting = !live.active || !live.meetingId
    if (starting) {
      if (!hasPermission(authz.perms, Permission.startLive)) {
        return liveFailure('forbidden', 'Your role cannot start live sessions here. You can join once someone else starts one.')
      }
      const limiter = asRpc<{ take: (n: number, w: number) => Promise<boolean> }>(this.env.RATE_LIMIT_DO.getByName(`user:${user.id}:live`))
      if (!await limiter.take(10, 60 * 60 * 1000)) return liveFailure('rate_limited', 'Too many live sessions started. Try again later.')
      const kind = liveKindFor(directMessage && await this.directMessageSize() === 2)
      try {
        const meeting = await media.createMeeting(`${kind}:${this.channelId()}`)
        live = { active: true, meetingId: meeting.id, participantIds: [], startedBy: user.id, startedAt: nowIso(), kind, ringing: kind === 'call' }
      }
      catch {
        return liveFailure('realtimekit_failed', 'RealtimeKit could not start the live session')
      }
    }
    const meetingId = live.meetingId!
    const seats = starting ? {} : await this.liveSeats()
    const host = isLiveHost(live, user.id, { directMessage, perms: authz.perms })
    let participant: RealtimeKitParticipant
    try {
      participant = await media.addParticipant(meetingId, { name: user.displayName, customId: user.id, host })
    }
    catch {
      if (starting) this.ctx.waitUntil(media.endMeeting(meetingId).catch(() => {}))
      return liveFailure('realtimekit_failed', 'RealtimeKit could not add you to the live session')
    }

    // One seat per person: joining again, say from another tab, replaces the older seat.
    const previous = seats[user.id]
    if (previous) this.ctx.waitUntil(media.removeParticipants(meetingId, [previous.participantId]).catch(() => {}))
    seats[user.id] = { participantId: participant.id }
    if (!live.participantIds.includes(user.id)) live.participantIds.push(user.id)
    if (live.ringing && user.id !== live.startedBy) {
      live.ringing = false
      await this.ctx.storage.delete('liveRingUntil')
    }
    const presence = starting ? {} : await this.livePresence()
    presence[user.id] = Date.now() + LIVE_PRESENCE_TTL_MS
    await this.ctx.storage.put({ livePresence: presence, liveSeats: seats })
    await this.ctx.storage.delete('liveCleanupAt')
    if (starting && live.ringing) await this.ctx.storage.put('liveRingUntil', Date.now() + LIVE_RING_TIMEOUT_MS)
    await this.setLive(live)

    if (starting) {
      const notification = await liveNotificationStatement(this.env, this.channelId(), meetingId, user, live.kind)
      await this.env.DB.batch([
        this.env.DB.prepare('UPDATE channels SET live_meeting_id = ? WHERE id = ?').bind(meetingId, this.channelId()),
        this.env.DB.prepare(
          'INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(newId(), user.id, 'live.start', 'channel', this.channelId(), JSON.stringify({ kind: live.kind }), nowIso()),
        ...(notification ? [notification] : []),
      ])
      this.ctx.waitUntil(signalNotificationOutbox(this.env))
    }
    await this.refreshAlarm()
    this.publishLive(live, starting ? { started: user } : {})
    return { ok: true, token: participant.token, meetingId, live }
  }

  private async leaveLiveNow(userId: string): Promise<LiveState> {
    const live = await this.getLive()
    if (!live.active || !live.meetingId) return live
    const seats = await this.liveSeats()
    const seat = seats[userId]
    if (!seat && !live.participantIds.includes(userId)) return live
    // Hanging up ends a Call for both people.
    if (live.kind === 'call' && seat) return this.endLiveNow({})
    const { [userId]: _seat, ...remainingSeats } = seats
    const { [userId]: _presence, ...presence } = await this.livePresence()
    live.participantIds = live.participantIds.filter(id => id !== userId)
    await this.ctx.storage.put({ livePresence: presence, liveSeats: remainingSeats })
    if (seat) {
      const media = await liveMedia(this.env)
      if (media) this.ctx.waitUntil(media.removeParticipants(live.meetingId, [seat.participantId]).catch(() => {}))
    }
    if (!live.participantIds.length) await this.scheduleCleanup(liveGraceMs(live.kind, await this.isDirectMessage()))
    await this.setLive(live)
    await this.refreshAlarm()
    this.publishLive(live)
    return live
  }

  private async endLiveNow(opts: { outcome?: 'declined' | 'unanswered' }): Promise<LiveState> {
    const current = await this.getLive()
    const media = await liveMedia(this.env)
    if (current.meetingId && media) await media.endMeeting(current.meetingId)
    const live: LiveState = { ...emptyLive(), kind: current.kind }
    await this.setLive(live)
    await this.ctx.storage.delete(['livePresence', 'liveCleanupAt', 'liveSeats', 'liveRingUntil'])
    await this.env.DB.prepare('UPDATE channels SET live_meeting_id = NULL WHERE id = ?').bind(this.channelId()).run()
    await this.refreshAlarm()
    this.publishLive(live, opts)
    return live
  }

  private async liveAlarm() {
    const now = Date.now()
    const live = await this.getLive()
    const ringUntil = await this.ctx.storage.get<number>('liveRingUntil')
    if (live.active && live.ringing && ringUntil && ringUntil <= now) {
      try {
        await this.endLiveNow({ outcome: 'unanswered' })
      }
      catch {
        await this.ctx.storage.put('liveRingUntil', now + 60_000)
        await this.refreshAlarm()
      }
      return
    }
    const cleanupAt = await this.ctx.storage.get<number>('liveCleanupAt')
    if (cleanupAt && cleanupAt <= now) {
      if (live.active && !live.participantIds.length) {
        try {
          await this.endLiveNow({})
        }
        catch {
          await this.scheduleCleanup(60_000)
        }
        return
      }
      await this.ctx.storage.delete('liveCleanupAt')
    }
    await this.expireLiveParticipants(now)
    await this.refreshAlarm()
  }

  private publishLive(live: LiveState, opts: { started?: PublicUser, outcome?: 'declined' | 'unanswered' } = {}) {
    this.ctx.waitUntil(this.broadcast({ t: 'live', live }))
    this.ctx.waitUntil(signalLiveChanged(this.env, this.channelId(), live, opts).catch(() => {}))
  }

  private async hello(ws: WebSocket, user: PublicUser, sessionId?: string) {
    const authz = await this.loadAuthz(user.id)
    if (!authz) {
      this.send(ws, { t: 'error', code: 'not_found', message: 'Channel not found' })
      ws.close(4404, 'not_found')
      return
    }
    ws.serializeAttachment({ userId: user.id, user, sessionId } satisfies Sock)
    const live = await this.getLive()
    let participants: PublicUser[] | undefined
    if (isDmType(authz.type) || (authz.type === 'thread')) {
      participants = await this.loadDmParticipants()
    }
    const agentTurns = authz.canManageAgents ? await listAgentTurns(this.env, this.channelId()) : []
    this.send(ws, { t: 'hello', channelId: this.channelId(), you: user, live, frozen: authz.frozen, participants, agentTurns })
  }

  private async authTimeout(ws: WebSocket) {
    // A cold server session lookup includes KV and D1 round trips.
    await new Promise((r) => setTimeout(r, 10000))
    const sock = ws.deserializeAttachment() as Sock | null
    if (!sock?.userId) {
      try { ws.close(4001, 'unauthorized') }
      catch { /* closed */ }
    }
  }

  private async loadAuthz(userId: string): Promise<Authz | null> {
    const ch = await this.env.DB.prepare(
      'SELECT id, type, visibility, parent_id FROM channels WHERE id = ?',
    ).bind(this.channelId()).first<{ id: string; type: string; visibility: string; parent_id: string | null }>()
    if (!ch) return null
    const type = ch.type
    let accessRoot = ch
    if (type === 'thread' && ch.parent_id) {
      const parent = await this.env.DB.prepare('SELECT id, type, visibility, parent_id FROM channels WHERE id = ?').bind(ch.parent_id).first<{ id: string; type: string; visibility: string; parent_id: string | null }>()
      if (!parent) return null
      accessRoot = parent
    }

    const membership = await this.env.DB.prepare(
      `SELECT u.kind, r.permissions_bitmask as perms, r.resource_access_json as resourceAccessJson, r.id as roleId, w.owner_id as ownerId
       FROM users u
       JOIN roles r ON r.id = u.role_id
       CROSS JOIN server w
       WHERE u.id = ? AND u.status = 'active'`,
    ).bind(userId).first<{ kind: 'human' | 'agent'; perms: number; roleId: string; ownerId: string; resourceAccessJson: string }>()
    if (!membership) return null
    const discussion = await this.env.DB.prepare('SELECT board_id as boardId, project_id as projectId FROM tasks WHERE discussion_channel_id = ?')
      .bind(accessRoot.id).first<{ boardId: string; projectId: string | null }>()
    if (discussion?.projectId && membership.ownerId !== userId && (!hasPermission(membership.perms, Permission.readProjects) || !resourceAccessAllows(parseResourceAccess(membership.resourceAccessJson), 'projects', discussion.projectId))) return null
    if (discussion && membership.ownerId !== userId && (!hasPermission(membership.perms, Permission.readTasks)
      || !resourceAccessAllows(parseResourceAccess(membership.resourceAccessJson), 'boards', discussion.boardId))) return null
    const canManageAgents = membership.ownerId === userId || hasPermission(membership.perms, Permission.useAgents)

    if (accessRoot.visibility === 'private') {
      const part = await this.env.DB.prepare(
        'SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?',
      ).bind(accessRoot.id, userId).first()
      if (!part) return null
    }

    if (isDmType(accessRoot.type)) {
      const parts = await this.env.DB.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').bind(accessRoot.id).all<{ user_id: string }>()
      const ids = (parts.results ?? []).map((p) => p.user_id)
      let frozen = false
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',')
        if (!canManageAgents) {
          const agent = await this.env.DB.prepare(
            `SELECT 1 FROM users WHERE id IN (${placeholders}) AND kind = 'agent' LIMIT 1`,
          ).bind(...ids).first()
          if (!canAccessAgentConversation(membership.kind, canManageAgents, Boolean(agent))) return null
        }
        const still = await this.env.DB.prepare(
          `SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'active'`,
        ).bind(...ids).all<{ id: string }>()
        frozen = (still.results ?? []).length !== ids.length
      }
      const perms = directMessagePermissions(membership.perms, membership.ownerId === userId, frozen)
      return { serverId: (await getServerId(this.env.DB)), type: accessRoot.id === ch.id ? 'dm' : type, perms, ownerId: membership.ownerId, frozen, canManageAgents, mailbox: false }
    }
    let perms = membership.ownerId === userId ? ALL_PERMISSIONS : membership.perms
    if (membership.ownerId !== userId) {
      const override = await this.env.DB.prepare(
        'SELECT allow_mask, deny_mask FROM channel_role_overrides WHERE channel_id = ? AND role_id = ?',
      ).bind(accessRoot.id, membership.roleId).first<{ allow_mask: number; deny_mask: number }>()
      perms = resolveChannelPermissions(perms, override && { allow: override.allow_mask, deny: override.deny_mask })
    }
    const mailbox = await this.env.DB.prepare(
      `SELECT mb.enabled, a.permission
       FROM email_mailboxes mb
       LEFT JOIN email_mailbox_access a ON a.channel_id = mb.channel_id AND a.user_id = ?
       WHERE mb.channel_id = ?`,
    ).bind(userId, accessRoot.id).first<{ enabled: number; permission: 'read' | 'send' | 'manage' | null }>()
    if (mailbox) {
      if (!mailbox.enabled || !mailbox.permission || (membership.ownerId !== userId && !hasPermission(membership.perms, Permission.readMail))) return null
      perms &= ~Permission.startLive
      if (!mailPermissionAllows(mailbox.permission, 'send') || (membership.ownerId !== userId && !hasPermission(membership.perms, Permission.sendMail))) {
        perms &= ~(Permission.sendMessages | Permission.attachFiles)
      } else {
        perms |= Permission.sendMessages | Permission.attachFiles
      }
    }
    return { serverId: (await getServerId(this.env.DB)), type, perms, ownerId: membership.ownerId, frozen: false, canManageAgents, mailbox: Boolean(mailbox) }
  }

  private async loadDmParticipants(): Promise<PublicUser[]> {
    const ch = await this.env.DB.prepare('SELECT id, type, parent_id FROM channels WHERE id = ?').bind(this.channelId()).first<{ id: string; type: string; parent_id: string | null }>()
    if (!ch) return []
    const dmId = isDmType(ch.type) ? ch.id : ch.parent_id
    if (!dmId) return []
    const rows = await this.env.DB.prepare(
      `SELECT u.id, u.kind, u.display_name, u.avatar_r2_key
       FROM channel_members p JOIN users u ON u.id = p.user_id WHERE p.channel_id = ?`,
    ).bind(dmId).all<{ id: string; kind: 'human' | 'agent'; display_name: string; avatar_r2_key: string | null }>()
    return (rows.results ?? []).map((r) => ({ id: r.id, kind: r.kind, displayName: r.display_name, avatarR2Key: r.avatar_r2_key }))
  }

  private async persistMessage(dto: MessageDTO, replyToId: string | null) {
    const notification = await messageNotificationStatement(this.env, {
      id: dto.id,
      channelId: dto.channelId,
      author: dto.author,
      content: dto.content,
      mentions: dto.mentions,
      attachmentCount: dto.attachments.length,
    })
    const statements = [
      this.env.DB.prepare(
        'INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, edited_at, deleted_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)',
      ).bind(dto.id, dto.channelId, dto.author.id, dto.content, replyToId, dto.createdAt),
      ...dto.attachments.map((attachment) => this.env.DB.prepare(
        'UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL AND channel_id = ? AND uploader_id = ?',
      ).bind(dto.id, attachment.id, dto.channelId, dto.author.id)),
      ...dto.mentions.map((uid) => this.env.DB.prepare(
        'INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)',
      ).bind(dto.id, uid)),
      this.env.DB.prepare(
        `INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id, user_id) DO UPDATE
         SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
         WHERE channel_reads.last_read_message_id IS NULL
            OR channel_reads.last_read_message_id < excluded.last_read_message_id`,
      ).bind(dto.channelId, dto.author.id, dto.id, dto.createdAt),
      ...(notification ? [notification] : []),
    ]
    await this.env.DB.batch(statements)
  }

  private async loadAttachments(userId: string, ids: string[]): Promise<AttachmentDTO[]> {
    if (!ids.length) return []
    const out: AttachmentDTO[] = []
    for (const id of ids) {
      const row = await this.env.DB.prepare(
        'SELECT id, r2_key, filename, content_type, size_bytes, width, height FROM attachments WHERE id = ? AND message_id IS NULL AND channel_id = ? AND uploader_id = ?',
      ).bind(id, this.channelId(), userId).first<{
        id: string
        r2_key: string
        filename: string
        content_type: string
        size_bytes: number
        width: number | null
        height: number | null
      }>()
      if (!row) continue
      out.push({
        id: row.id,
        filename: row.filename,
        contentType: row.content_type,
        sizeBytes: row.size_bytes,
        width: row.width,
        height: row.height,
        url: `/api/files/${row.id}`,
      })
    }
    return out
  }

  private async validMentions(ids: string[]): Promise<string[]> {
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = await this.env.DB.prepare(
      `SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'active'`,
    ).bind(...ids).all<{ id: string }>()
    return (rows.results ?? []).map((row) => row.id)
  }

  private async loadMessage(id: string): Promise<MessageDTO | null> {
    const row = await this.env.DB.prepare(
      `SELECT m.id, m.channel_id, m.content, m.reply_to_id, m.edited_at, m.deleted_at, m.created_at,
              u.id as uid, u.kind, u.display_name, u.avatar_r2_key
       FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?`,
    ).bind(id).first<{
      id: string
      channel_id: string
      content: string
      reply_to_id: string | null
      edited_at: string | null
      deleted_at: string | null
      created_at: string
      uid: string
      kind: 'human' | 'agent'
      display_name: string
      avatar_r2_key: string | null
    }>()
    if (!row) return null
    const mentionRows = await this.env.DB.prepare('SELECT user_id FROM message_mentions WHERE message_id = ?').bind(id).all<{ user_id: string }>()
    const attRows = await this.env.DB.prepare(
      'SELECT id, r2_key, filename, content_type, size_bytes, width, height FROM attachments WHERE message_id = ?',
    ).bind(id).all<{
      id: string
      r2_key: string
      filename: string
      content_type: string
      size_bytes: number
      width: number | null
      height: number | null
    }>()
    const pin = await this.env.DB.prepare(
      `SELECT p.pinned_at, u.id, u.kind, u.display_name, u.avatar_r2_key
       FROM message_pins p JOIN users u ON u.id = p.pinned_by
       WHERE p.message_id = ?`,
    ).bind(id).first<{
      pinned_at: string
      id: string
      kind: 'human' | 'agent'
      display_name: string
      avatar_r2_key: string | null
    }>()
    return {
      id: row.id,
      channelId: row.channel_id,
      serverId: (await getServerId(this.env.DB)),
      author: { id: row.uid, kind: row.kind, displayName: row.display_name, avatarR2Key: row.avatar_r2_key },
      content: row.deleted_at ? '' : row.content,
      replyTo: null,
      mentions: (mentionRows.results ?? []).map((r) => r.user_id),
      attachments: (row.deleted_at ? [] : attRows.results ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        contentType: a.content_type,
        sizeBytes: a.size_bytes,
        width: a.width,
        height: a.height,
        url: `/api/files/${a.id}`,
      })),
      reactions: [],
      pin: pin
        ? {
            pinnedBy: { id: pin.id, kind: pin.kind, displayName: pin.display_name, avatarR2Key: pin.avatar_r2_key },
            pinnedAt: pin.pinned_at,
          }
        : null,
      threadId: null,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
    }
  }

  private async scheduleCleanup(delayMs: number) {
    await this.ctx.storage.put('liveCleanupAt', Date.now() + delayMs)
    await this.refreshAlarm()
  }

  private async livePresence(): Promise<Record<string, number>> {
    return await this.ctx.storage.get<Record<string, number>>('livePresence') ?? {}
  }

  /** RealtimeKit participant records of everyone who joined and has not left. */
  private async liveSeats(): Promise<Record<string, { participantId: string }>> {
    return await this.ctx.storage.get<Record<string, { participantId: string }>>('liveSeats') ?? {}
  }

  private async expireLiveParticipants(now: number) {
    const live = await this.getLive()
    if (!live.active || !live.participantIds.length) return
    const presence = await this.livePresence()
    const alive = live.participantIds.filter(userId => (presence[userId] ?? 0) > now)
    if (alive.length === live.participantIds.length) return
    live.participantIds = alive
    const aliveSet = new Set(alive)
    const remainingPresence = Object.fromEntries(Object.entries(presence).filter(([userId]) => aliveSet.has(userId)))
    await this.ctx.storage.put('livePresence', remainingPresence)
    await this.setLive(live)
    this.publishLive(live)
    if (!alive.length) await this.scheduleCleanup(liveGraceMs(live.kind, await this.isDirectMessage()))
  }

  private async refreshAlarm() {
    const cleanupAt = await this.ctx.storage.get<number>('liveCleanupAt')
    const ringUntil = await this.ctx.storage.get<number>('liveRingUntil')
    const presence = Object.values(await this.livePresence())
    const presenceAt = presence.length ? Math.min(...presence) : undefined
    const candidates = [cleanupAt, ringUntil, presenceAt]
      .filter((value): value is number => typeof value === 'number')
    if (candidates.length) await this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...candidates)))
    else await this.ctx.storage.deleteAlarm()
  }

  private async setLive(live: LiveState) {
    await this.ctx.storage.put('live', live)
  }

  private async isDirectMessage(): Promise<boolean> {
    const row = await this.env.DB.prepare('SELECT type FROM channels WHERE id = ?').bind(this.channelId()).first<{ type: string }>()
    return isDmType(row?.type ?? '')
  }

  private async directMessageSize(): Promise<number> {
    const row = await this.env.DB.prepare('SELECT count(*) AS count FROM channel_members WHERE channel_id = ?')
      .bind(this.channelId()).first<{ count: number }>()
    return row?.count ?? 0
  }
  private channelId(): string {
    return (this.ctx.id.name ?? '').replace(/^channel:/, '')
  }

  private async broadcast(msg: ServerMsg, except?: WebSocket) {
    const payload = JSON.stringify(msg)
    const sockets = await authorizedSockets(this.ctx.getWebSockets(), async (userId, session) => {
      if (!await socketSessionActive(this.env, session)) return false
      const authz = await this.loadAuthz(userId)
      return Boolean(authz && !authz.frozen)
    })
    for (const ws of sockets) {
      if (except && ws === except) continue
      try { ws.send(payload) }
      catch { /* ignore */ }
    }
  }

  private async sendToUser(userId: string, msg: ServerMsg) {
    const payload = JSON.stringify(msg)
    for (const ws of await authorizedSockets(this.ctx.getWebSockets(), (_id, session) => socketSessionActive(this.env, session))) {
      const sock = ws.deserializeAttachment() as Sock | null
      if (sock?.userId !== userId) continue
      try { ws.send(payload) }
      catch { /* ignore */ }
    }
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    try { ws.send(JSON.stringify(msg)) }
    catch { /* ignore */ }
  }
}

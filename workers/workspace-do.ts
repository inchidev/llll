import { DurableObject } from 'cloudflare:workers'
import type { PresenceStatus, PublicUser } from '../shared/types'
import type { WorkspaceChannelActivityEvent, WorkspaceChannelReadEvent, WorkspaceLiveChangedEvent, WorkspaceMailChangedEvent, WorkspaceMembersChangedEvent, WorkspaceTasksChangedEvent } from '../shared/workspace-realtime'
import type { L4Env } from './env'
import { userFromTicket } from './ticket'
import { sendWorkspaceEvent, type WorkspaceSocketAttachment } from './workspace-events'
import { workspacePresence } from './workspace-presence'

const PRESENCE_TICK_MS = 60_000

/** Owns installation-wide ephemeral presence and targeted unread signals. D1 remains source of truth. */
export class WorkspaceDurableObject extends DurableObject<L4Env> {
  constructor(ctx: DurableObjectState, env: L4Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    this.ctx.waitUntil(this.authTimeout(pair[1]))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    let parsed: { t?: string; token?: string; visible?: boolean }
    try {
      parsed = JSON.parse(message) as { t?: string; token?: string; visible?: boolean }
    }
    catch {
      return
    }

    const attachment = ws.deserializeAttachment() as WorkspaceSocketAttachment | null
    if (parsed.t === 'auth' && parsed.token) {
      const user = await userFromTicket(this.env, parsed.token)
      if (!user) {
        ws.close(4001, 'unauthorized')
        return
      }
      await this.attach(ws, user, parsed.visible !== false)
      return
    }
    if (!attachment?.userId || parsed.t !== 'activity') return

    ws.serializeAttachment({
      userId: attachment.userId,
      lastActive: Date.now(),
      visible: parsed.visible !== false,
    } satisfies WorkspaceSocketAttachment)
    this.broadcast()
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as WorkspaceSocketAttachment | null
    if (attachment?.userId) this.broadcast()
    await this.scheduleTick()
  }

  async snapshot(): Promise<Array<{ userId: string; status: PresenceStatus }>> {
    return this.currentPresence()
  }

  async notifyChannelActivity(event: WorkspaceChannelActivityEvent, recipientIds: string[]): Promise<void> {
    sendWorkspaceEvent(this.ctx.getWebSockets(), new Set(recipientIds), event)
  }

  async notifyChannelRead(event: WorkspaceChannelReadEvent, userId: string): Promise<void> {
    sendWorkspaceEvent(this.ctx.getWebSockets(), new Set([userId]), event)
  }

  async notifyTasksChanged(event: WorkspaceTasksChangedEvent): Promise<void> {
    this.broadcastMessage(event)
  }

  async notifyMailChanged(event: WorkspaceMailChangedEvent, recipientIds: string[]): Promise<void> {
    sendWorkspaceEvent(this.ctx.getWebSockets(), new Set(recipientIds), event)
  }

  async notifyMembersChanged(event: WorkspaceMembersChangedEvent): Promise<void> {
    this.broadcastMessage(event)
  }

  async notifyLiveChanged(event: WorkspaceLiveChangedEvent, recipientIds: string[]): Promise<void> {
    sendWorkspaceEvent(this.ctx.getWebSockets(), new Set(recipientIds), event)
  }

  override async alarm(): Promise<void> {
    this.broadcast()
    await this.scheduleTick()
  }

  private async attach(ws: WebSocket, user: PublicUser, visible: boolean) {
    ws.serializeAttachment({ userId: user.id, lastActive: Date.now(), visible } satisfies WorkspaceSocketAttachment)
    this.send(ws, { t: 'hello', workspaceId: this.workspaceId() })
    this.broadcast()
    await this.scheduleTick()
  }

  private async authTimeout(ws: WebSocket) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const attachment = ws.deserializeAttachment() as WorkspaceSocketAttachment | null
    if (!attachment?.userId) {
      try { ws.close(4001, 'unauthorized') }
      catch { /* already closed */ }
    }
  }

  private currentPresence(): Array<{ userId: string; status: PresenceStatus }> {
    return workspacePresence(this.ctx.getWebSockets())
  }

  private async scheduleTick() {
    const authenticated = this.ctx.getWebSockets().some((ws) => {
      const attachment = ws.deserializeAttachment() as WorkspaceSocketAttachment | null
      return Boolean(attachment?.userId)
    })
    if (authenticated) await this.ctx.storage.setAlarm(Date.now() + PRESENCE_TICK_MS)
    else await this.ctx.storage.deleteAlarm()
  }

  private workspaceId(): string {
    return (this.ctx.id.name ?? '').replace(/^workspace:/, '')
  }

  private broadcast() {
    this.broadcastMessage({ t: 'presence', users: this.currentPresence() })
  }

  private broadcastMessage(message: unknown) {
    const payload = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as WorkspaceSocketAttachment | null
      if (!attachment?.userId) continue
      try { ws.send(payload) }
      catch { /* ignore */ }
    }
  }

  private send(ws: WebSocket, msg: unknown) {
    try { ws.send(JSON.stringify(msg)) }
    catch { /* ignore */ }
  }
}

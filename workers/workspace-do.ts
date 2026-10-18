import { DurableObject } from 'cloudflare:workers'
import type { PresenceStatus, PublicUser } from '../shared/types'
import type { WorkspaceChannelActivityEvent, WorkspaceChannelReadEvent, WorkspaceLiveChangedEvent, WorkspaceMailChangedEvent, WorkspaceMembersChangedEvent, WorkspaceTasksChangedEvent } from '../shared/workspace-realtime'
import type { L4Env } from './env'
import { sessionFromTicket, socketSessionActive } from './ticket'
import { sendWorkspaceEvent, type WorkspaceSocketAttachment } from './workspace-events'
import { workspacePresence } from './workspace-presence'
import { authorizedSockets } from './socket-access'

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
      const session = await sessionFromTicket(this.env, parsed.token)
      if (!session) {
        ws.close(4001, 'unauthorized')
        return
      }
      await this.attach(ws, session.user, parsed.visible !== false, session.sessionId)
      return
    }
    if (!attachment?.userId || parsed.t !== 'activity') return

    ws.serializeAttachment({
      ...attachment,
      lastActive: Date.now(),
      visible: parsed.visible !== false,
    } satisfies WorkspaceSocketAttachment)
    await this.broadcast()
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as WorkspaceSocketAttachment | null
    if (attachment?.userId) await this.broadcast()
    await this.scheduleTick()
  }

  async snapshot(): Promise<Array<{ userId: string; status: PresenceStatus }>> {
    return workspacePresence(await this.activeSockets())
  }

  async notifyChannelActivity(event: WorkspaceChannelActivityEvent, recipientIds: string[]): Promise<void> {
    sendWorkspaceEvent(await this.activeSockets(), new Set(recipientIds), event)
  }

  async notifyChannelRead(event: WorkspaceChannelReadEvent, userId: string): Promise<void> {
    sendWorkspaceEvent(await this.activeSockets(), new Set([userId]), event)
  }

  async notifyTasksChanged(event: WorkspaceTasksChangedEvent): Promise<void> {
    await this.broadcastMessage(event)
  }

  async notifyMailChanged(event: WorkspaceMailChangedEvent, recipientIds: string[]): Promise<void> {
    sendWorkspaceEvent(await this.activeSockets(), new Set(recipientIds), event)
  }

  async notifyMembersChanged(event: WorkspaceMembersChangedEvent): Promise<void> {
    await this.broadcastMessage(event)
  }

  async notifyLiveChanged(event: WorkspaceLiveChangedEvent, recipientIds: string[]): Promise<void> {
    sendWorkspaceEvent(await this.activeSockets(), new Set(recipientIds), event)
  }

  override async alarm(): Promise<void> {
    await this.broadcast()
    await this.scheduleTick()
  }

  private async attach(ws: WebSocket, user: PublicUser, visible: boolean, sessionId?: string) {
    ws.serializeAttachment({ userId: user.id, sessionId, lastActive: Date.now(), visible } satisfies WorkspaceSocketAttachment)
    this.send(ws, { t: 'hello', workspaceId: this.workspaceId() })
    await this.broadcast()
    await this.scheduleTick()
  }

  private async authTimeout(ws: WebSocket) {
    // A cold installation session lookup includes KV and D1 round trips.
    await new Promise((resolve) => setTimeout(resolve, 10000))
    const attachment = ws.deserializeAttachment() as WorkspaceSocketAttachment | null
    if (!attachment?.userId) {
      try { ws.close(4001, 'unauthorized') }
      catch { /* already closed */ }
    }
  }

  private async activeSockets() {
    return authorizedSockets(this.ctx.getWebSockets(), (_id, session) => socketSessionActive(this.env, session))
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

  private async broadcast() {
    const sockets = await this.activeSockets()
    await this.broadcastMessage({ t: 'presence', users: workspacePresence(sockets) }, sockets)
  }

  private async broadcastMessage(message: unknown, authorized?: WebSocket[]) {
    const payload = JSON.stringify(message)
    for (const ws of authorized || await this.activeSockets()) {
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

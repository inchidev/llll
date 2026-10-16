import { DurableObject } from 'cloudflare:workers'
import type { L4Env } from './env'
import { drainNotificationOutbox, nextNotificationDueAt } from './push'

export class NotificationDurableObject extends DurableObject<L4Env> {
  async kick(): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    const immediate = Date.now() + 100
    if (current === null || current > immediate) await this.ctx.storage.setAlarm(immediate)
  }

  override async alarm(): Promise<void> {
    await drainNotificationOutbox(this.env)
    const dueAt = await nextNotificationDueAt(this.env)
    if (dueAt !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, dueAt))
  }
}

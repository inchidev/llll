import { DurableObject } from 'cloudflare:workers'
import type { L4Env } from './env'
import { findSchedule, executeScheduledOccurrence, recordScheduleFailure } from '../server/utils/schedule-service'

/** One durable alarm per mandate; occurrence identity survives retries and code updates. */
export class AgentScheduleDurableObject extends DurableObject<L4Env> {
  async wake(id: string): Promise<void> {
    await this.ctx.storage.put('scheduleId', id)
    const item = await findSchedule(this.env, id)
    if (item?.status === 'active' && item.nextAt) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Date.parse(item.nextAt)))
    else await this.ctx.storage.deleteAlarm()
  }
  override async alarm(): Promise<void> {
    const id = await this.ctx.storage.get<string>('scheduleId')
    const item = id ? await findSchedule(this.env, id) : null
    if (!item || item.status !== 'active' || !item.nextAt) return
    if (Date.parse(item.nextAt) > Date.now()) { await this.wake(item.id); return }
    // Persist a retry before delivery, so a crash or a failure to record the error cannot lose the occurrence.
    await this.ctx.storage.setAlarm(Date.now() + 30000)
    try {
      await executeScheduledOccurrence(this.env, item, promise => this.ctx.waitUntil(promise))
    } catch (error) {
      const retryAt = await recordScheduleFailure(this.env, item, error)
      if (retryAt) { await this.ctx.storage.setAlarm(retryAt); return }
    }
    await this.wake(item.id)
  }
}

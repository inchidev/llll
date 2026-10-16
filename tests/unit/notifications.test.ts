import { describe, expect, it } from 'vitest'
import {
  isBase64UrlKey,
  isSafePushEndpoint,
  notificationPreview,
  pushDeliveryDisposition,
  pushRetryDelayMs,
} from '../../shared/notifications'
import { liveNotificationStatement, messageNotificationStatement } from '../../workers/notifications'
import { workerPushRequestInit } from '../../workers/push'

type QueryResult = Record<string, unknown> | Array<Record<string, unknown>> | null

class FakeStatement {
  args: unknown[] = []

  constructor(
    readonly sql: string,
    private readonly result: QueryResult,
  ) {}

  bind(...args: unknown[]) {
    this.args = args
    return this
  }

  async first<T>() {
    return (Array.isArray(this.result) ? this.result[0] : this.result) as T | null
  }

  async all<T>() {
    return { results: (Array.isArray(this.result) ? this.result : []) as T[] }
  }
}

class FakeDb {
  statements: FakeStatement[] = []

  constructor(private readonly results: QueryResult[]) {}

  prepare(sql: string) {
    const statement = new FakeStatement(sql, this.results.shift() ?? null)
    this.statements.push(statement)
    return statement
  }
}

function env(results: QueryResult[]) {
  const db = new FakeDb(results)
  return {
    db,
    env: { DB: db } as never,
  }
}

const actor = { id: 'actor', displayName: 'Alice', avatarR2Key: null }

describe('notification helpers', () => {
  it('classifies push service responses', () => {
    expect(pushDeliveryDisposition(201)).toBe('delivered')
    expect(pushDeliveryDisposition(410)).toBe('expired')
    expect(pushDeliveryDisposition(429)).toBe('retry')
    expect(pushDeliveryDisposition(503)).toBe('retry')
    expect(pushDeliveryDisposition(400)).toBe('failed')
  })

  it('lets the Workers runtime calculate the outbound push content length', () => {
    const request = workerPushRequestInit({
      method: 'post',
      headers: {
        authorization: 'vapid token',
        'content-length': '4096',
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array([1, 2, 3]),
    })

    expect(request.headers.get('content-length')).toBeNull()
    expect(request.headers.get('authorization')).toBe('vapid token')
    expect(request.body).toEqual(new Uint8Array([1, 2, 3]))
    expect(request.redirect).toBe('manual')
  })

  it('bounds retries and message previews', () => {
    expect(pushRetryDelayMs(1)).toBe(15_000)
    expect(pushRetryDelayMs(99)).toBe(60 * 60 * 1000)
    expect(notificationPreview('<@01234567-89ab-cdef-0123-456789abcdef>  hello', 0)).toBe('@member hello')
    expect(notificationPreview('', 2)).toBe('Sent 2 attachments')
    expect(notificationPreview('a'.repeat(200), 0)).toHaveLength(140)
  })

  it('accepts external HTTPS capability URLs and rejects local targets', () => {
    expect(isSafePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/token')).toBe(true)
    expect(isSafePushEndpoint('http://push.example.com/token')).toBe(false)
    expect(isSafePushEndpoint('https://127.0.0.1/token')).toBe(false)
    expect(isSafePushEndpoint('https://service.internal/token')).toBe(false)
    expect(isBase64UrlKey('abcd_EFGH-1234xyz', 16, 64)).toBe(true)
    expect(isBase64UrlKey('not base64!', 4, 64)).toBe(false)
  })
})

describe('notification recipients', () => {
  it('enqueues only active mentions for a workspace channel', async () => {
    const fake = env([
      { id: 'channel', name: 'general', type: 'text', visibility: 'workspace', parent_id: null },
      [{ id: 'mentioned' }],
    ])
    const statement = await messageNotificationStatement(fake.env, {
      id: 'message', channelId: 'channel', author: actor, content: 'hello', mentions: ['actor', 'mentioned'], attachmentCount: 0,
    }) as unknown as FakeStatement

    expect(statement).toBeTruthy()
    expect(fake.db.statements[1]!.args).toEqual(['mentioned'])
    expect(statement.args.at(-1)).toBe('mentioned')
    expect(JSON.parse(String(statement.args[3]))).toMatchObject({ url: '/channels/channel', tag: 'message:message' })
  })

  it('does not enqueue an inaccessible private-channel mention', async () => {
    const fake = env([
      { id: 'private', name: 'secret', type: 'text', visibility: 'private', parent_id: null },
      [],
    ])
    const statement = await messageNotificationStatement(fake.env, {
      id: 'message', channelId: 'private', author: actor, content: 'hello', mentions: ['outsider'], attachmentCount: 0,
    })

    expect(statement).toBeNull()
    expect(fake.db.statements[1]!.args).toEqual(['private', 'outsider'])
  })

  it('notifies other DM participants and deep-links through a DM thread parent', async () => {
    const fake = env([
      { id: 'thread', name: 'thread', type: 'thread', visibility: 'private', parent_id: 'dm' },
      { id: 'dm', name: 'dm', type: 'dm', visibility: 'private', parent_id: null },
      [{ user_id: 'other-a' }, { user_id: 'other-b' }],
    ])
    const statement = await messageNotificationStatement(fake.env, {
      id: 'message', channelId: 'thread', author: actor, content: '', mentions: ['other-a'], attachmentCount: 1,
    }) as unknown as FakeStatement

    expect(statement.args.slice(-2)).toEqual(['other-a', 'other-b'])
    expect(JSON.parse(String(statement.args[3]))).toMatchObject({
      title: 'Alice',
      body: 'Sent an attachment',
      url: '/channels/dm/threads/thread',
    })
  })

  it('notifies the other active people in a workspace Channel when it goes live', async () => {
    const fake = env([
      { id: 'general', name: 'general', type: 'text', visibility: 'workspace', parent_id: null },
      [{ id: 'other' }],
    ])
    const statement = await liveNotificationStatement(fake.env, 'general', 'meeting', actor, 'live') as unknown as FakeStatement

    expect(fake.db.statements[1]!.sql).toContain(`kind = 'human'`)
    expect(fake.db.statements[1]!.args).toEqual(['actor'])
    expect(statement.args.at(-1)).toBe('other')
    expect(JSON.parse(String(statement.args[3]))).toMatchObject({
      title: 'Alice is live in #general',
      tag: 'live:meeting',
      url: '/channels/general',
    })
  })

  it('rings the other participant of a 1:1 Direct Message', async () => {
    const fake = env([
      { id: 'dm', name: 'dm', type: 'dm', visibility: 'private', parent_id: null },
      [{ id: 'other' }],
    ])
    const statement = await liveNotificationStatement(fake.env, 'dm', 'meeting', actor, 'call') as unknown as FakeStatement

    expect(fake.db.statements[1]!.args).toEqual(['dm', 'actor'])
    expect(JSON.parse(String(statement.args[3]))).toMatchObject({ title: 'Alice is calling', body: 'Tap to answer' })
  })
})

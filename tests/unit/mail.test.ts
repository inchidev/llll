import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { mailAddress, mailPermissionAllows, normalizeMailLocalPart } from '../../shared/mail'
import { serverMailDomains } from '../../server/utils/server-mail'

describe('server mail model', () => {
  it('normalizes mailbox addresses and rejects unsafe local parts', () => {
    expect(normalizeMailLocalPart(' Support ')).toBe('support')
    expect(mailAddress('support', 'example.com')).toBe('support@example.com')
    expect(() => normalizeMailLocalPart('../support')).toThrow()
    expect(() => normalizeMailLocalPart('two words')).toThrow()
  })

  it('orders mailbox permissions from read through manage', () => {
    expect(mailPermissionAllows('read', 'read')).toBe(true)
    expect(mailPermissionAllows('read', 'send')).toBe(false)
    expect(mailPermissionAllows('send', 'read')).toBe(true)
    expect(mailPermissionAllows('manage', 'send')).toBe(true)
  })

  it('reads multiple deployment-managed email domains', () => {
    expect(serverMailDomains({
      LLLL_EMAIL_DOMAINS: JSON.stringify([
        { id: 'main', zoneId: 'zone-1', domain: 'afterprompt.example.com' },
        { id: 'second', zoneId: 'zone-2', domain: 'analflare.example.net' },
      ]),
    } as never)).toEqual([
      { id: 'main', zoneId: 'zone-1', domain: 'afterprompt.example.com' },
      { id: 'second', zoneId: 'zone-2', domain: 'analflare.example.net' },
    ])
  })

  it('boots mail as companion tables around channels and messages', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'email_%' ORDER BY name").all()
    expect(tables).toEqual([
      { name: 'email_domains' },
      { name: 'email_mailbox_access' },
      { name: 'email_mailboxes' },
      { name: 'email_messages' },
      { name: 'email_threads' },
    ])
    sqlite.exec("INSERT INTO email_domains (id, zone_id, domain, app_hostname) VALUES ('afterprompt', 'zone', 'afterprompt.example.com', 'chat.example.com')")
    sqlite.exec("INSERT INTO email_domains (id, zone_id, domain, app_hostname) VALUES ('analflare', 'zone', 'analflare.example.com', 'chat.example.com')")
    expect(sqlite.prepare('SELECT domain FROM email_domains ORDER BY domain').all()).toEqual([
      { domain: 'afterprompt.example.com' },
      { domain: 'analflare.example.com' },
    ])
    expect(() => sqlite.exec("INSERT INTO email_domains (id, zone_id, domain, app_hostname) VALUES ('duplicate', 'zone', 'afterprompt.example.com', 'chat.example.com')")).toThrow()
    sqlite.close()
  })

})

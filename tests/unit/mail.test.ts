import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import workspaceMailSql from '../fixtures/legacy-migrations/0014_workspace_mail.sql?raw'
import multipleEmailDomainsSql from '../fixtures/legacy-migrations/0025_multiple_email_domains.sql?raw'
import { d1ExecSql, INIT_SQL } from '../../server/utils/db'
import { mailAddress, mailPermissionAllows, normalizeMailLocalPart } from '../../shared/mail'
import { workspaceMailDomains } from '../../server/utils/workspace-mail'

describe('workspace mail model', () => {
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

  it('accepts MAIL_DOMAIN without a zone id off Cloudflare', () => {
    expect(workspaceMailDomains({
      LLLL_RUNTIME: 'celld',
      MAIL_DOMAIN: 'Chat.Example.com',
    } as never)).toEqual([
      { id: 'main', zoneId: '', domain: 'chat.example.com' },
    ])
  })

  it('keeps requiring MAIL_ZONE_ID for the legacy domain on Cloudflare', () => {
    expect(workspaceMailDomains({
      LLLL_RUNTIME: 'cloudflare',
      MAIL_DOMAIN: 'chat.example.com',
    } as never)).toEqual([])
    expect(workspaceMailDomains({
      MAIL_DOMAIN: 'chat.example.com',
      MAIL_ZONE_ID: 'zone-1',
    } as never)).toEqual([
      { id: 'main', zoneId: 'zone-1', domain: 'chat.example.com' },
    ])
  })

  it('reads multiple deployment-managed email domains and preserves legacy bindings', () => {
    expect(workspaceMailDomains({
      LLLL_EMAIL_DOMAINS: JSON.stringify([
        { id: 'main', zoneId: 'zone-1', domain: 'afterprompt.example.com' },
        { id: 'second', zoneId: 'zone-2', domain: 'analflare.example.net' },
      ]),
      MAIL_DOMAIN: 'afterprompt.example.com',
      MAIL_ZONE_ID: 'zone-1',
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

  it('preserves the full mail foreign-key chain while removing the singleton domain constraint', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys=ON')
    sqlite.exec('CREATE TABLE channels (id text PRIMARY KEY NOT NULL)')
    sqlite.exec('CREATE TABLE users (id text PRIMARY KEY NOT NULL)')
    sqlite.exec('CREATE TABLE messages (id text PRIMARY KEY NOT NULL)')
    sqlite.exec(d1ExecSql(workspaceMailSql))
    sqlite.exec("INSERT INTO channels VALUES ('mailbox'), ('thread')")
    sqlite.exec("INSERT INTO users VALUES ('owner')")
    sqlite.exec("INSERT INTO messages VALUES ('message')")
    sqlite.exec("INSERT INTO email_domains (id, zone_id, domain, app_hostname) VALUES ('main', 'zone', 'project.example.com', 'app.example.com')")
    sqlite.exec("INSERT INTO email_mailboxes (channel_id, domain_id, local_part, display_name) VALUES ('mailbox', 'main', 'support', 'Support')")
    sqlite.exec("INSERT INTO email_mailbox_access (channel_id, user_id, permission) VALUES ('mailbox', 'owner', 'manage')")
    sqlite.exec("INSERT INTO email_threads (channel_id, mailbox_channel_id, subject, last_message_at) VALUES ('thread', 'mailbox', 'Hello', '2026-09-25T00:00:00.000Z')")
    sqlite.exec("INSERT INTO email_messages (message_id, thread_channel_id, direction, from_address) VALUES ('message', 'thread', 'inbound', 'sender@example.net')")

    sqlite.exec(d1ExecSql(multipleEmailDomainsSql))

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM email_messages').get()).toEqual({ count: 1 })
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    sqlite.exec("INSERT INTO email_domains (id, zone_id, domain, app_hostname) VALUES ('second', 'zone', 'other.example.com', 'app.example.com')")
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM email_domains').get()).toEqual({ count: 2 })
    sqlite.close()
  })
})

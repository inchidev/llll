import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MemberPermissions, Permission } from '../../shared/permissions'
import { canManageMessagePins, INSERT_MESSAGE_PIN_SQL } from '../../server/utils/message-pins'

describe('message pin authorization', () => {
  it('uses manageChannels for workspace channels and inherited threads', () => {
    expect(canManageMessagePins({ accessRootType: 'text', frozen: false, perms: Permission.manageChannels })).toBe(true)
    expect(canManageMessagePins({ accessRootType: 'text', frozen: false, perms: MemberPermissions })).toBe(false)
  })

  it('allows writable DM participants and rejects frozen DMs', () => {
    expect(canManageMessagePins({ accessRootType: 'dm', frozen: false, perms: MemberPermissions })).toBe(true)
    expect(canManageMessagePins({ accessRootType: 'dm', frozen: true, perms: MemberPermissions })).toBe(false)
    expect(canManageMessagePins({ accessRootType: 'dm', frozen: false, perms: 0 })).toBe(false)
  })
})

describe('message pin persistence', () => {
  it('makes repeated pin requests idempotent', () => {
    expect(INSERT_MESSAGE_PIN_SQL).toContain('INSERT OR IGNORE INTO message_pins')
  })

  it('cascades pins when their message is physically deleted', () => {
    const path = fileURLToPath(new URL('../fixtures/legacy-migrations/0005_message_pins.sql', import.meta.url))
    const migration = readFileSync(path, 'utf8')
    expect(migration).toContain('`message_id` text PRIMARY KEY NOT NULL')
    expect(migration).toContain('REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade')
    expect(migration).toContain('`pinned_by` text NOT NULL')
    expect(migration).toContain('`pinned_at` text NOT NULL')
  })
})

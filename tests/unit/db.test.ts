import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { d1ExecSql } from '../../server/utils/db'
import { LEGACY_SQL as INIT_SQL } from '../fixtures/legacy-migrations/init'
import agentsAndTasksSql from '../fixtures/legacy-migrations/0007_agents_and_tasks.sql?raw'
import agentTurnsSql from '../fixtures/legacy-migrations/0008_agent_turns.sql?raw'
import taskManagementSql from '../fixtures/legacy-migrations/0009_task_management.sql?raw'
import adminTaskBoundarySql from '../fixtures/legacy-migrations/0011_admin_task_boundary.sql?raw'
import agentIdentityBoundarySql from '../fixtures/legacy-migrations/0012_agent_identity_boundary.sql?raw'
import taskNumbersSql from '../fixtures/legacy-migrations/0020_task_numbers.sql?raw'
import realtimeV1Sql from '../fixtures/legacy-migrations/0021_realtime_v1.sql?raw'
import agentPrincipalsAndApprovalsSql from '../fixtures/legacy-migrations/0022_agent_principals_and_approvals.sql?raw'
import gadgetsSql from '../fixtures/legacy-migrations/0024_gadgets.sql?raw'
import retireTaskExecutionSql from '../fixtures/legacy-migrations/0026_retire_task_execution.sql?raw'
import retireScheduledHuddlesSql from '../fixtures/legacy-migrations/0029_retire_scheduled_huddles.sql?raw'
import liveRoomsSql from '../fixtures/legacy-migrations/0030_live_rooms_replace_voice_channels.sql?raw'

describe('ensureMigrated', () => {
  it('does not apply the bundled schema when the runtime is celld', async () => {
    vi.resetModules()
    const { ensureMigrated } = await import('../../server/utils/db')
    const exec = vi.fn(async () => {})
    const db = {
      exec,
      prepare: () => ({
        first: async () => {
          throw new Error('missing table')
        },
      }),
    }

    await expect(ensureMigrated(db as never, { LLLL_RUNTIME: 'celld' })).rejects.toThrow('missing table')
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('D1 bootstrap schema', () => {
  it('passes one complete statement per line to D1 exec', () => {
    const lines = INIT_SQL.trim().split('\n')

    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every(line => line.trim().endsWith(';'))).toBe(true)
  })

  it('uses the singleton workspace and generalized private-channel model', () => {
    expect(INIT_SQL).toContain('CREATE TABLE IF NOT EXISTS `workspace`')
    expect(INIT_SQL).toContain('CREATE TABLE IF NOT EXISTS `users`')
    expect(INIT_SQL).not.toContain('CREATE TABLE IF NOT EXISTS `members`')
    expect(INIT_SQL).toContain('CREATE TABLE IF NOT EXISTS `channel_members`')
    expect(INIT_SQL).toContain('CREATE TABLE `channel_categories`')
    expect(INIT_SQL).toContain('`category_id` text REFERENCES channel_categories(id) ON DELETE SET NULL')
    expect(INIT_SQL).toContain('CREATE TABLE IF NOT EXISTS `auth_users`')
    expect(INIT_SQL).toContain('CREATE TABLE IF NOT EXISTS `auth_sessions`')
    expect(INIT_SQL).toContain('CREATE VIRTUAL TABLE `message_search` USING fts5')
    expect(INIT_SQL).toContain('CREATE TRIGGER `message_search_after_update`')
    expect(INIT_SQL).toContain('CREATE TABLE `push_subscriptions`')
    expect(INIT_SQL).toContain('CREATE TABLE `notification_outbox`')
    expect(INIT_SQL).toContain('CREATE TABLE `message_pins`')
    expect(INIT_SQL).toContain('CREATE TABLE `channel_role_overrides`')
    expect(INIT_SQL).toContain('CREATE TABLE `realtimekit_settings`')
    expect(INIT_SQL).toContain('CREATE TABLE `backup_destinations`')
    expect(INIT_SQL).toContain('CREATE TABLE `mcp_access_tokens`')
    expect(INIT_SQL).toContain('CREATE TABLE `documents`')
    expect(INIT_SQL).toContain('CREATE TABLE `canvases`')
    expect(INIT_SQL).toContain('CREATE TABLE `canvas_nodes`')
    expect(INIT_SQL).toContain('CREATE TABLE `canvas_edges`')
    expect(INIT_SQL).toContain('CREATE TABLE `database_views`')
    expect(INIT_SQL).toContain('CREATE TABLE `data_bookmarks`')
    expect(INIT_SQL).toContain('CREATE TABLE `gadgets`')
    expect(INIT_SQL).toContain('CREATE TABLE `gadget_versions`')
    expect(INIT_SQL).toContain('CREATE TABLE `gadget_draft_role_access`')
    expect(INIT_SQL).toContain('CREATE TABLE `gadget_version_role_access`')
    expect(INIT_SQL).toContain('CREATE TRIGGER `database_default_view_after_insert`')
    expect(INIT_SQL).toContain('CREATE TABLE `onboarding_revisions`')
    expect(INIT_SQL).toContain('CREATE TABLE `onboarding_acceptances`')
    expect(INIT_SQL).toContain('CREATE TABLE `email_domains`')
    expect(INIT_SQL).toContain('CREATE TABLE `email_mailboxes`')
    expect(INIT_SQL).toContain('CREATE TABLE `email_threads`')
    expect(INIT_SQL).toContain('CREATE TABLE `email_messages`')
    expect(INIT_SQL).toContain('CREATE TABLE `agents`')
    expect(INIT_SQL).toContain('CREATE TABLE `task_boards`')
    expect(INIT_SQL).toContain('CREATE TABLE `tasks`')
    expect(INIT_SQL).toContain('CREATE TABLE `task_runs`')
    expect(INIT_SQL).toContain('CREATE TABLE `task_labels`')
    expect(INIT_SQL).toContain('CREATE TABLE `task_label_links`')
    expect(INIT_SQL).toContain('CREATE TABLE `task_dependencies`')
    expect(INIT_SQL).toContain('CREATE TABLE `task_checklist_items`')
    expect(INIT_SQL).toContain('CREATE TABLE `task_attachments`')
    expect(INIT_SQL).toContain('CREATE TABLE `task_numbers`')
    expect(INIT_SQL).toContain('CREATE TABLE `task_number_sequence`')
    expect(INIT_SQL).toContain('CREATE TRIGGER `tasks_assign_number_after_insert`')
    expect(INIT_SQL).toContain('CREATE TABLE `scheduled_huddles`')
    expect(INIT_SQL).not.toContain('CREATE TABLE IF NOT EXISTS `sessions`')
    expect(INIT_SQL).not.toContain('password_hash')
    expect(INIT_SQL).not.toContain('guild_id')
    expect(INIT_SQL).not.toContain('dm_participants')
  })

  it('adds conversation-scoped scheduled huddles without changing existing channels', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)
    sqlite.exec("INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('role', 'member', 'Member', 0)")
    sqlite.exec("INSERT INTO identity_keys (id, name, email) VALUES ('user', 'User', 'user@example.com')")
    sqlite.exec("INSERT INTO users (id, kind, display_name, status, role_id, joined_at) VALUES ('user', 'human', 'User', 'active', 'role', '2026-09-08T10:00:00.000Z')")
    sqlite.exec("INSERT INTO channels (id, name, type, visibility) VALUES ('channel', 'General', 'text', 'workspace')")
    sqlite.exec("INSERT INTO scheduled_huddles (id, channel_id, title, starts_at, created_by) VALUES ('scheduled', 'channel', 'Weekly sync', '2026-09-09T10:00:00.000Z', 'user')")

    expect(sqlite.prepare('SELECT channel_id, title, status, meeting_id FROM scheduled_huddles').get()).toEqual({
      channel_id: 'channel',
      title: 'Weekly sync',
      status: 'scheduled',
      meeting_id: null,
    })
    expect(realtimeV1Sql).toContain('REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade')
    sqlite.close()
  })

  it('cancels schedules that had not started when scheduling is retired', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)
    sqlite.exec("INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('role', 'member', 'Member', 0)")
    sqlite.exec("INSERT INTO identity_keys (id, name, email) VALUES ('user', 'User', 'user@example.com')")
    sqlite.exec("INSERT INTO users (id, kind, display_name, status, role_id, joined_at) VALUES ('user', 'human', 'User', 'active', 'role', '2026-09-08T10:00:00.000Z')")
    sqlite.exec("INSERT INTO channels (id, name, type, visibility) VALUES ('channel', 'General', 'text', 'workspace')")
    for (const [id, status] of [['pending', 'scheduled'], ['due', 'ready'], ['held', 'started'], ['dropped', 'cancelled']]) {
      sqlite.exec(`INSERT INTO scheduled_huddles (id, channel_id, starts_at, status, created_by) VALUES ('${id}', 'channel', '2026-09-09T10:00:00.000Z', '${status}', 'user')`)
    }

    sqlite.exec(d1ExecSql(retireScheduledHuddlesSql))

    expect(sqlite.prepare('SELECT id, status FROM scheduled_huddles ORDER BY id').all()).toEqual([
      { id: 'dropped', status: 'cancelled' },
      { id: 'due', status: 'cancelled' },
      { id: 'held', status: 'started' },
      { id: 'pending', status: 'cancelled' },
    ])
    sqlite.close()
  })

  it('turns retired voice Channels into text Channels and splits RealtimeKit presets by role', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)
    sqlite.exec("INSERT INTO channels (id, name, type, visibility) VALUES ('voice', 'General', 'voice', 'workspace')")
    sqlite.exec("INSERT INTO channels (id, name, type, visibility) VALUES ('text', 'general', 'text', 'workspace')")

    sqlite.exec(liveRoomsSql.split('--> statement-breakpoint')[0]!)

    expect(sqlite.prepare('SELECT id, type FROM channels ORDER BY id').all()).toEqual([
      { id: 'text', type: 'text' },
      { id: 'voice', type: 'text' },
    ])
    const columns = sqlite.prepare('PRAGMA table_info(realtimekit_settings)').all().map(column => (column as { name: string }).name)
    expect(columns).toEqual(expect.arrayContaining(['host_preset', 'participant_preset']))
    expect(columns).not.toContain('voice_preset')
    sqlite.close()
  })

  it('keeps trigger bodies together as one D1 exec statement', () => {
    const sql = d1ExecSql(`
      CREATE TRIGGER example AFTER UPDATE ON messages BEGIN
        DELETE FROM derived WHERE id = OLD.id;
        INSERT INTO derived (id) VALUES (NEW.id);
      END;
      --> statement-breakpoint
      SELECT 1;
    `)
    const lines = sql.split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('DELETE FROM derived WHERE id = OLD.id; INSERT INTO derived')
    expect(lines[0]).toMatch(/END;$/u)
  })

  it('adds Gadget storage and grants new capabilities to existing admin roles', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE roles (id TEXT PRIMARY KEY, key TEXT NOT NULL, permissions_bitmask INTEGER NOT NULL);
      INSERT INTO roles VALUES ('admin-role', 'admin', 1023);
      INSERT INTO roles VALUES ('member-role', 'member', 112);
    `)
    sqlite.exec(d1ExecSql(gadgetsSql))
    expect(sqlite.prepare("SELECT permissions_bitmask FROM roles WHERE key = 'admin'").get()).toEqual({ permissions_bitmask: 4095 })
    expect(sqlite.prepare("SELECT permissions_bitmask FROM roles WHERE key = 'member'").get()).toEqual({ permissions_bitmask: 112 })
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gadget%' ORDER BY name").all()).toEqual([
      { name: 'gadget_draft_role_access' }, { name: 'gadget_version_role_access' }, { name: 'gadget_versions' }, { name: 'gadgets' },
    ])
    sqlite.close()
  })

  it('boots with constrained channel role overrides', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)

    sqlite.exec("INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('role', 'custom:role', 'Role', 0)")
    sqlite.exec("INSERT INTO channels (id, name, type, visibility) VALUES ('channel', 'Channel', 'text', 'workspace')")
    sqlite.exec("INSERT INTO channel_role_overrides (channel_id, role_id, allow_mask, deny_mask) VALUES ('channel', 'role', 16, 32)")

    expect(() => sqlite.exec(
      "INSERT INTO channel_role_overrides (channel_id, role_id, allow_mask, deny_mask) VALUES ('channel', 'role-2', 2, 0)",
    )).toThrow()
    expect(() => sqlite.exec(
      "INSERT INTO channel_role_overrides (channel_id, role_id, allow_mask, deny_mask) VALUES ('channel-2', 'role', 16, 16)",
    )).toThrow()
  })

  it('models an agent as a participant without credentials or a browser session', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)
    sqlite.exec("INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('member-role', 'member', 'member', 112)")
    sqlite.exec("INSERT INTO identity_keys (id, name, email) VALUES ('agent-1', 'Builder', 'agent+agent-1@llll.invalid')")
    sqlite.exec("INSERT INTO users (id, kind, display_name, status, role_id, joined_at) VALUES ('agent-1', 'agent', 'Builder', 'active', 'member-role', '2026-09-04T00:00:00.000Z')")
    sqlite.exec("INSERT INTO agents (user_id, computer_id, created_by) VALUES ('agent-1', 'agent:agent-1', 'agent-1')")
    sqlite.exec("INSERT INTO task_boards (id, name, created_by) VALUES ('board-1', 'Launch', 'agent-1')")
    sqlite.exec("INSERT INTO tasks (id, board_id, title, assignee_id, created_by) VALUES ('task-1', 'board-1', 'Ship it', 'agent-1', 'agent-1')")
    sqlite.exec("INSERT INTO task_runs (id, task_id, agent_id, status, progress, created_at) VALUES ('run-1', 'task-1', 'agent-1', 'running', 'Thinking', '2026-09-04T00:00:00.000Z')")
    sqlite.exec("INSERT INTO task_labels (id, board_id, name, created_by) VALUES ('label-1', 'board-1', 'urgent', 'agent-1')")
    sqlite.exec("INSERT INTO task_label_links (task_id, label_id) VALUES ('task-1', 'label-1')")
    sqlite.exec("INSERT INTO task_checklist_items (id, task_id, title, created_by) VALUES ('item-1', 'task-1', 'Verify', 'agent-1')")

    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_accounts').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_sessions').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_users').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT kind FROM users WHERE id = ?').get('agent-1')).toEqual({ kind: 'agent' })
    expect(sqlite.prepare('SELECT assignee_id FROM tasks WHERE id = ?').get('task-1')).toEqual({ assignee_id: 'agent-1' })
    expect(sqlite.prepare('SELECT priority, active_run_id FROM tasks WHERE id = ?').get('task-1')).toEqual({ priority: 'normal', active_run_id: null })
    expect(sqlite.prepare('SELECT number FROM task_numbers WHERE task_id = ?').get('task-1')).toEqual({ number: 1001 })
    expect(sqlite.prepare('SELECT status, progress, task_status_before FROM task_runs WHERE id = ?').get('run-1')).toEqual({ status: 'running', progress: 'Thinking', task_status_before: 'ready' })
  })

  it('backfills existing MCP token subjects and preserves Task Run history', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE mcp_access_tokens (
        id TEXT PRIMARY KEY,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE task_runs (id TEXT PRIMARY KEY, progress TEXT);
      INSERT INTO users VALUES ('owner');
      INSERT INTO mcp_access_tokens VALUES ('token', 'owner');
      INSERT INTO task_runs VALUES ('run', 'Thinking');
    `)

    sqlite.exec(d1ExecSql(agentPrincipalsAndApprovalsSql))

    expect(sqlite.prepare('SELECT subject_id FROM mcp_access_tokens WHERE id = ?').get('token')).toEqual({ subject_id: 'owner' })
    expect(sqlite.prepare('SELECT progress, approval_json FROM task_runs WHERE id = ?').get('run')).toEqual({ progress: 'Thinking', approval_json: null })
    sqlite.close()
  })

  it('retires active Task Runs without deleting their history', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        assignee_id TEXT,
        active_run_id TEXT,
        updated_at TEXT
      );
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        task_status_before TEXT NOT NULL,
        status TEXT NOT NULL,
        progress TEXT,
        approval_json TEXT,
        cancelled_at TEXT,
        error TEXT
      );
      INSERT INTO tasks VALUES ('task-1', 'running', 'agent-1', 'run-1', 'before');
      INSERT INTO task_runs VALUES ('run-1', 'review', 'running', 'Thinking', '{"executionId":"approval-1"}', NULL, NULL);
    `)

    sqlite.exec(d1ExecSql(retireTaskExecutionSql))

    expect(sqlite.prepare('SELECT status, active_run_id FROM tasks WHERE id = ?').get('task-1')).toEqual({ status: 'review', active_run_id: null })
    expect(sqlite.prepare('SELECT status, progress, approval_json, error FROM task_runs WHERE id = ?').get('run-1')).toEqual({
      status: 'cancelled',
      progress: null,
      approval_json: null,
      error: 'Task execution was retired in L4 0.1.5',
    })
    sqlite.close()
  })

  it('adds participant kind without replacing a referenced users table', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE auth_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        email_verified INTEGER NOT NULL DEFAULT 0,
        image TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX auth_users_email_unique ON auth_users(email);
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        handle TEXT,
        display_name TEXT NOT NULL,
        avatar_r2_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        role_id TEXT,
        nickname TEXT,
        joined_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id) REFERENCES auth_users(id) ON DELETE CASCADE
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES users(id)
      );
      CREATE TABLE roles (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        permissions_bitmask INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE channels (id TEXT PRIMARY KEY);
      INSERT INTO auth_users (id, name, email) VALUES ('human-1', 'Alice', 'alice@example.com');
      INSERT INTO users (id, display_name) VALUES ('human-1', 'Alice');
      INSERT INTO messages VALUES ('message-1', 'human-1');
    `)

    sqlite.exec(d1ExecSql(agentsAndTasksSql))

    expect(sqlite.prepare('SELECT kind FROM users WHERE id = ?').get('human-1')).toEqual({ kind: 'human' })
    expect(sqlite.prepare('SELECT author_id FROM messages WHERE id = ?').get('message-1')).toEqual({ author_id: 'human-1' })
    sqlite.close()
  })

  it('backfills stable task numbers and lets the database assign every later number', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES ('old-a', '2001 — Preserve this number', '2026-09-01T00:00:00.000Z');
      INSERT INTO tasks VALUES ('old-b', 'No manual number', '2026-09-02T00:00:00.000Z');
      INSERT INTO tasks VALUES ('old-c', '3000 — Duplicate prefix', '2026-09-03T00:00:00.000Z');
      INSERT INTO tasks VALUES ('old-d', '3000 — Duplicate prefix again', '2026-09-04T00:00:00.000Z');
    `)

    sqlite.exec(d1ExecSql(taskNumbersSql))

    expect(sqlite.prepare('SELECT task_id, number FROM task_numbers ORDER BY number').all()).toEqual([
      { task_id: 'old-a', number: 2001 },
      { task_id: 'old-b', number: 2002 },
      { task_id: 'old-c', number: 2003 },
      { task_id: 'old-d', number: 2004 },
    ])
    sqlite.exec("INSERT INTO tasks VALUES ('new-a', 'Created after migration', '2026-09-05T00:00:00.000Z')")
    sqlite.exec("DELETE FROM tasks WHERE id = 'old-b'")
    sqlite.exec("INSERT INTO tasks VALUES ('new-b', 'Created after a deletion', '2026-09-06T00:00:00.000Z')")
    expect(sqlite.prepare('SELECT number FROM task_numbers WHERE task_id = ?').get('new-a')).toEqual({ number: 2005 })
    expect(sqlite.prepare('SELECT number FROM task_numbers WHERE task_id = ?').get('new-b')).toEqual({ number: 2006 })
    expect(sqlite.prepare('SELECT next_number FROM task_number_sequence WHERE id = 1').get()).toEqual({ next_number: 2007 })
    expect(() => sqlite.exec("INSERT INTO task_numbers VALUES ('old-b', 2001)")).toThrow()
    sqlite.close()
  })

  it('upgrades existing task runs without losing their history', () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE auth_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        email_verified INTEGER NOT NULL DEFAULT 0,
        image TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX auth_users_email_unique ON auth_users(email);
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        handle TEXT,
        display_name TEXT NOT NULL,
        avatar_r2_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        role_id TEXT,
        nickname TEXT,
        joined_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id) REFERENCES auth_users(id) ON DELETE CASCADE
      );
      CREATE TABLE messages (id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE roles (id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL, permissions_bitmask INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE channels (id TEXT PRIMARY KEY);
      INSERT INTO roles VALUES ('member-role', 'member', 'Member', 112);
      INSERT INTO roles VALUES ('admin-role', 'admin', 'Admin', 255);
      INSERT INTO roles VALUES ('custom-role', 'custom:ops', 'Ops', 112);
      INSERT INTO auth_users (id, name, email) VALUES ('agent-1', 'Builder', 'agent+agent-1@llll.invalid');
      INSERT INTO users (id, display_name, status, role_id, joined_at) VALUES ('agent-1', 'Builder', 'active', 'member-role', '2026-09-04T00:00:00.000Z');
    `)
    sqlite.exec(d1ExecSql(agentsAndTasksSql))
    sqlite.exec(d1ExecSql(agentTurnsSql))
    sqlite.exec(`
      INSERT INTO agents (user_id, computer_id, created_by) VALUES ('agent-1', 'agent:agent-1', 'agent-1');
      INSERT INTO task_boards (id, name, created_by) VALUES ('board-1', 'Launch', 'agent-1');
      INSERT INTO tasks (id, board_id, title, description, status, assignee_id, created_by)
        VALUES ('task-1', 'board-1', 'Ship it', 'Carefully', 'review', 'agent-1', 'agent-1');
      INSERT INTO task_runs (id, task_id, agent_id, status, summary, progress, created_at)
        VALUES ('run-1', 'task-1', 'agent-1', 'completed', 'Shipped', 'Finishing', '2026-09-04T00:00:00.000Z');
    `)

    sqlite.exec(d1ExecSql(taskManagementSql))
    sqlite.exec(d1ExecSql(adminTaskBoundarySql))
    sqlite.exec(d1ExecSql(agentIdentityBoundarySql))

    expect(sqlite.prepare('SELECT status, summary, progress, title_snapshot, description_snapshot, task_status_before FROM task_runs WHERE id = ?').get('run-1')).toEqual({
      status: 'completed',
      summary: 'Shipped',
      progress: 'Finishing',
      title_snapshot: 'Ship it',
      description_snapshot: 'Carefully',
      task_status_before: 'review',
    })
    expect(sqlite.prepare('SELECT permissions_bitmask FROM roles WHERE id = ?').get('member-role')).toEqual({ permissions_bitmask: 112 })
    expect(sqlite.prepare('SELECT permissions_bitmask FROM roles WHERE id = ?').get('admin-role')).toEqual({ permissions_bitmask: 511 })
    expect(sqlite.prepare('SELECT permissions_bitmask FROM roles WHERE id = ?').get('custom-role')).toEqual({ permissions_bitmask: 112 })
    expect(sqlite.prepare('SELECT count(*) AS count FROM auth_users WHERE id = ?').get('agent-1')).toEqual({ count: 0 })
    sqlite.exec("INSERT INTO identity_keys (id, name, email) VALUES ('agent-2', 'Reviewer', 'agent+agent-2@llll.invalid')")
    expect(() => sqlite.exec("INSERT INTO users (id, kind, display_name, status, role_id, joined_at) VALUES ('agent-2', 'agent', 'Reviewer', 'active', 'member-role', '2026-09-04T00:00:00.000Z')")).not.toThrow()
    sqlite.close()
  })
})

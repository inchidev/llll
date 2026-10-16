import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { CHANNEL_PERMISSION_MASK } from '../shared/channel-permissions'

function isoTimestamps() {
  return {
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  }
}

function authTimestamps() {
  return {
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast(unixepoch() * 1000 as integer))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast(unixepoch() * 1000 as integer))`),
  }
}

/** Stable participant keys preserve legacy foreign keys without creating login identities for Agents. */
export const identityKeys = sqliteTable('identity_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  ...authTimestamps(),
})

/** Better Auth owns the auth_* tables. L4's domain identity lives in users. */
export const authUsers = sqliteTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  ...authTimestamps(),
})

export const authSessions = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  ...authTimestamps(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => identityKeys.id, { onDelete: 'cascade' }),
}, table => [
  index('auth_sessions_user_id_idx').on(table.userId),
])

export const authAccounts = sqliteTable('auth_accounts', {
  id: text('id').primaryKey(),
  issuer: text('issuer').notNull().default('local:credential'),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => identityKeys.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  ...authTimestamps(),
}, table => [
  uniqueIndex('auth_accounts_issuer_account_idx').on(table.issuer, table.accountId),
  index('auth_accounts_user_id_idx').on(table.userId),
])

export const authVerifications = sqliteTable('auth_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sql`(cast(unixepoch() * 1000 as integer))`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(sql`(cast(unixepoch() * 1000 as integer))`),
})

/** Installation-wide admission policy and login-method switches. */
export const authSettings = sqliteTable('auth_settings', {
  id: text('id').primaryKey().default('main'),
  registrationMode: text('registration_mode', { enum: ['open', 'invite_only'] }).notNull().default('invite_only'),
  emailEnabled: integer('email_enabled', { mode: 'boolean' }).notNull().default(true),
  githubEnabled: integer('github_enabled', { mode: 'boolean' }).notNull().default(false),
  googleEnabled: integer('google_enabled', { mode: 'boolean' }).notNull().default(false),
  linkedinEnabled: integer('linkedin_enabled', { mode: 'boolean' }).notNull().default(false),
  twitterEnabled: integer('twitter_enabled', { mode: 'boolean' }).notNull().default(false),
  telegramEnabled: integer('telegram_enabled', { mode: 'boolean' }).notNull().default(false),
  turnstileEnabled: integer('turnstile_enabled', { mode: 'boolean' }).notNull().default(false),
  emailFrom: text('email_from'),
  emailFromName: text('email_from_name'),
  ...isoTimestamps(),
}, table => [
  check('auth_settings_singleton_check', sql`${table.id} = 'main'`),
  check('auth_settings_registration_mode_check', sql`${table.registrationMode} in ('open', 'invite_only')`),
])

/** OAuth and Turnstile secrets entered in the owner UI. Secrets are AES-GCM encrypted. */
export const authProviderCredentials = sqliteTable('auth_provider_credentials', {
  provider: text('provider', { enum: ['github', 'google', 'twitter', 'telegram', 'linkedin', 'turnstile'] }).primaryKey(),
  publicKey: text('public_key').notNull(),
  secretCiphertext: text('secret_ciphertext').notNull(),
  secretIv: text('secret_iv').notNull(),
  secretVersion: integer('secret_version').notNull().default(1),
  ...isoTimestamps(),
}, table => [
  check('auth_provider_credentials_provider_check', sql`${table.provider} in ('github', 'google', 'twitter', 'telegram', 'linkedin', 'turnstile')`),
])

/** Immutable published Privacy, Terms, and workspace Rules bundle. */
export const onboardingRevisions = sqliteTable('onboarding_revisions', {
  id: text('id').primaryKey(),
  version: integer('version').notNull(),
  privacyJson: text('privacy_json').notNull(),
  termsJson: text('terms_json').notNull(),
  rulesJson: text('rules_json').notNull(),
  createdBy: text('created_by').notNull().references(() => identityKeys.id),
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('onboarding_revisions_version_unique').on(table.version),
])

/** The exact published onboarding bundle accepted by an authentication identity. */
export const onboardingAcceptances = sqliteTable('onboarding_acceptances', {
  userId: text('user_id').notNull().references(() => identityKeys.id, { onDelete: 'cascade' }),
  revisionId: text('revision_id').notNull().references(() => onboardingRevisions.id, { onDelete: 'cascade' }),
  acceptedAt: text('accepted_at').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.revisionId] }),
  index('onboarding_acceptances_revision_idx').on(table.revisionId),
])

/** Installation-wide RealtimeKit credentials entered by the owner. The API token is AES-GCM encrypted. */
export const realtimekitSettings = sqliteTable('realtimekit_settings', {
  id: text('id').primaryKey().default('main'),
  accountId: text('account_id').notNull(),
  appId: text('app_id').notNull(),
  apiTokenCiphertext: text('api_token_ciphertext').notNull(),
  apiTokenIv: text('api_token_iv').notNull(),
  apiTokenVersion: integer('api_token_version').notNull().default(1),
  hostPreset: text('host_preset').notNull(),
  participantPreset: text('participant_preset').notNull(),
  ...isoTimestamps(),
}, table => [
  check('realtimekit_settings_singleton_check', sql`${table.id} = 'main'`),
])

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  permissionsBitmask: integer('permissions_bitmask').notNull(),
  position: integer('position').notNull().default(0),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  ...isoTimestamps(),
})

/** Workspace participants. Humans map to Better Auth identities; agents do not log in. */
export const users = sqliteTable('users', {
  id: text('id').primaryKey().references(() => identityKeys.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['human', 'agent'] }).notNull().default('human'),
  handle: text('handle').unique(),
  displayName: text('display_name').notNull(),
  avatarR2Key: text('avatar_r2_key'),
  status: text('status', { enum: ['pending', 'active', 'removed'] }).notNull().default('pending'),
  roleId: text('role_id').references(() => roles.id),
  nickname: text('nickname'),
  joinedAt: text('joined_at'),
  ...isoTimestamps(),
}, table => [
  index('users_status_idx').on(table.status),
  index('users_kind_idx').on(table.kind),
  index('users_role_id_idx').on(table.roleId),
  check('users_kind_check', sql`${table.kind} in ('human', 'agent')`),
  check('users_status_check', sql`${table.status} in ('pending', 'active', 'removed')`),
  check('users_active_role_check', sql`${table.status} <> 'active' or (${table.roleId} is not null and ${table.joinedAt} is not null)`),
])

/** Stateful AI participant profile. Runtime memory lives in its Agent Durable Object. */
export const agents = sqliteTable('agents', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  model: text('model').notNull().default('@cf/moonshotai/kimi-k2.7-code'),
  instructions: text('instructions').notNull().default(''),
  status: text('status', { enum: ['active', 'paused'] }).notNull().default('active'),
  // Retained for compatibility with existing databases; no external runtime is provisioned.
  legacyRuntimeId: text('computer_id').notNull().unique(),
  createdBy: text('created_by').notNull().references(() => users.id),
  lastActiveAt: text('last_active_at'),
  ...isoTimestamps(),
}, table => [
  index('agents_status_idx').on(table.status),
  check('agents_status_check', sql`${table.status} in ('active', 'paused')`),
])

/** Workspace-visible state for active conversational turns. Think remains authoritative for execution. */
export const agentTurns = sqliteTable('agent_turns', {
  submissionId: text('submission_id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.userId, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  sourceMessageId: text('source_message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  initiatedBy: text('initiated_by').notNull().references(() => users.id),
  requestId: text('request_id'),
  status: text('status', { enum: ['queued', 'thinking', 'tool', 'waiting_approval'] }).notNull().default('queued'),
  detail: text('detail'),
  draftMessageId: text('draft_message_id').references(() => messages.id, { onDelete: 'set null' }),
  approvalJson: text('approval_json'),
  ...isoTimestamps(),
}, table => [
  index('agent_turns_channel_agent_idx').on(table.channelId, table.agentId, table.createdAt),
  uniqueIndex('agent_turns_request_id_unique').on(table.requestId),
  check('agent_turns_status_check', sql`${table.status} in ('queued', 'thinking', 'tool', 'waiting_approval')`),
])

/** One row per installation. Its id is not copied into workspace-owned tables. */
export const workspace = sqliteTable('workspace', {
  id: text('id').primaryKey().default('main'),
  name: text('name').notNull(),
  iconR2Key: text('icon_r2_key'),
  ownerId: text('owner_id').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  check('workspace_singleton_check', sql`${table.id} = 'main'`),
])

/** Revocable MCP credentials. Only their SHA-256 digests are retained. */
export const mcpAccessTokens = sqliteTable('mcp_access_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  tokenPrefix: text('token_prefix').notNull(),
  scopesJson: text('scopes_json').notNull(),
  subjectId: text('subject_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('mcp_access_tokens_hash_unique').on(table.tokenHash),
  index('mcp_access_tokens_subject_id_idx').on(table.subjectId),
  index('mcp_access_tokens_created_by_idx').on(table.createdBy),
  index('mcp_access_tokens_active_idx').on(table.revokedAt, table.createdAt),
])

/** Owner-controlled anonymous project heartbeat. No workspace data is included. */
export const telemetrySettings = sqliteTable('telemetry_settings', {
  id: text('id').primaryKey().default('main'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  updatedAt: text('updated_at').notNull(),
}, table => [
  check('telemetry_settings_singleton_check', sql`${table.id} = 'main'`),
])

/** Owner-configured S3-compatible destination for manual off-site backups. */
export const backupDestinations = sqliteTable('backup_destinations', {
  id: text('id').primaryKey().default('main'),
  endpoint: text('endpoint').notNull(),
  region: text('region').notNull().default('auto'),
  bucket: text('bucket').notNull(),
  prefix: text('prefix').notNull().default('llll'),
  accessKeyId: text('access_key_id').notNull(),
  secretAccessKeyCiphertext: text('secret_access_key_ciphertext').notNull(),
  secretAccessKeyIv: text('secret_access_key_iv').notNull(),
  secretAccessKeyVersion: integer('secret_access_key_version').notNull().default(1),
  lastBackupKey: text('last_backup_key'),
  lastBackupAt: text('last_backup_at'),
  lastBackupSizeBytes: integer('last_backup_size_bytes'),
  ...isoTimestamps(),
}, table => [
  check('backup_destinations_singleton_check', sql`${table.id} = 'main'`),
])

export const channelCategories = sqliteTable('channel_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  ...isoTimestamps(),
}, table => [
  index('channel_categories_position_idx').on(table.position),
])

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  topic: text('topic').notNull().default(''),
  type: text('type', { enum: ['text', 'thread', 'dm'] }).notNull(),
  visibility: text('visibility', { enum: ['workspace', 'private'] }).notNull().default('workspace'),
  categoryId: text('category_id').references(() => channelCategories.id, { onDelete: 'set null' }),
  position: integer('position').notNull().default(0),
  /** The active Live room's RealtimeKit meeting; the column keeps its pre-Live name. */
  liveMeetingId: text('huddle_meeting_id'),
  parentId: text('parent_id').references((): AnySQLiteColumn => channels.id, { onDelete: 'cascade' }),
  parentMessageId: text('parent_message_id').references((): AnySQLiteColumn => messages.id, { onDelete: 'cascade' }),
  ...isoTimestamps(),
}, table => [
  index('channels_position_idx').on(table.position),
  index('channels_type_idx').on(table.type),
  index('channels_category_id_idx').on(table.categoryId),
  index('channels_parent_id_idx').on(table.parentId),
  uniqueIndex('channels_thread_root_unique').on(table.parentMessageId).where(sql`${table.type} = 'thread'`),
  // Retired 'voice' Channels were converted to text; the stored constraint still allows the old value.
  check('channels_type_check', sql`${table.type} in ('text', 'voice', 'thread', 'dm')`),
  check('channels_visibility_check', sql`${table.visibility} in ('workspace', 'private')`),
  check('channels_dm_private_check', sql`${table.type} <> 'dm' or ${table.visibility} = 'private'`),
  check('channels_thread_parent_check', sql`
    (${table.type} = 'thread' and ${table.parentId} is not null and ${table.parentMessageId} is not null)
    or (${table.type} <> 'thread' and ${table.parentId} is null and ${table.parentMessageId} is null)
  `),
])

/**
 * Retired: scheduling huddles was removed until L4 has a calendar
 * (migration 0029 cancelled pending schedules). Kept so existing history remains.
 */
export const scheduledHuddles = sqliteTable('scheduled_huddles', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  startsAt: text('starts_at').notNull(),
  status: text('status', { enum: ['scheduled', 'ready', 'started', 'cancelled'] }).notNull().default('scheduled'),
  createdBy: text('created_by').notNull().references(() => users.id),
  meetingId: text('meeting_id'),
  ...isoTimestamps(),
}, table => [
  index('scheduled_huddles_channel_start_idx').on(table.channelId, table.startsAt),
  index('scheduled_huddles_status_start_idx').on(table.status, table.startsAt),
  check('scheduled_huddles_status_check', sql`${table.status} in ('scheduled', 'ready', 'started', 'cancelled')`),
])

/** Per-role send/attach/start-live exceptions for workspace channels. Threads inherit their parent. */
export const channelRoleOverrides = sqliteTable('channel_role_overrides', {
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  allowMask: integer('allow_mask').notNull().default(0),
  denyMask: integer('deny_mask').notNull().default(0),
  ...isoTimestamps(),
}, table => [
  primaryKey({ columns: [table.channelId, table.roleId] }),
  index('channel_role_overrides_role_id_idx').on(table.roleId),
  check('channel_role_overrides_allow_check', sql`(${table.allowMask} & ~${sql.raw(String(CHANNEL_PERMISSION_MASK))}) = 0`),
  check('channel_role_overrides_deny_check', sql`(${table.denyMask} & ~${sql.raw(String(CHANNEL_PERMISSION_MASK))}) = 0`),
  check('channel_role_overrides_disjoint_check', sql`(${table.allowMask} & ${table.denyMask}) = 0`),
])

/** Access to private channels, including DMs. Threads inherit their parent. */
export const channelMembers = sqliteTable('channel_members', {
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hiddenAt: text('hidden_at'),
  joinedAt: text('joined_at').notNull(),
}, table => [
  primaryKey({ columns: [table.channelId, table.userId] }),
  index('channel_members_user_id_idx').on(table.userId),
])

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  replyToId: text('reply_to_id').references((): AnySQLiteColumn => messages.id, { onDelete: 'set null' }),
  editedAt: text('edited_at'),
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
}, table => [
  index('messages_channel_created_idx').on(table.channelId, table.createdAt, table.id),
  index('messages_author_id_idx').on(table.authorId),
])

export const channelReads = sqliteTable('channel_reads', {
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastReadMessageId: text('last_read_message_id').references(() => messages.id, { onDelete: 'set null' }),
  updatedAt: text('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.channelId, table.userId] }),
  index('channel_reads_user_id_idx').on(table.userId),
])

export const invites = sqliteTable('invites', {
  code: text('code').primaryKey(),
  creatorId: text('creator_id').notNull().references(() => users.id),
  maxUses: integer('max_uses').notNull().default(0),
  uses: integer('uses').notNull().default(0),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull(),
}, table => [
  index('invites_creator_id_idx').on(table.creatorId),
  index('invites_expires_at_idx').on(table.expiresAt),
])

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  uploaderId: text('uploader_id').notNull().references(() => users.id),
  r2Key: text('r2_key').notNull().unique(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  width: integer('width'),
  height: integer('height'),
  createdAt: text('created_at').notNull(),
}, table => [
  index('attachments_message_id_idx').on(table.messageId),
  index('attachments_channel_id_idx').on(table.channelId),
  index('attachments_uploader_id_idx').on(table.uploaderId),
  check('attachments_size_check', sql`${table.sizeBytes} > 0`),
])

export const messageReactions = sqliteTable('message_reactions', {
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.messageId, table.userId, table.emoji] }),
  index('message_reactions_user_id_idx').on(table.userId),
])

export const messagePins = sqliteTable('message_pins', {
  messageId: text('message_id').primaryKey().references(() => messages.id, { onDelete: 'cascade' }),
  pinnedBy: text('pinned_by').notNull().references(() => users.id),
  pinnedAt: text('pinned_at').notNull(),
}, table => [
  index('message_pins_pinned_by_idx').on(table.pinnedBy),
  index('message_pins_pinned_at_idx').on(table.pinnedAt),
])

export const messageMentions = sqliteTable('message_mentions', {
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, table => [
  primaryKey({ columns: [table.messageId, table.userId] }),
  index('message_mentions_user_id_idx').on(table.userId),
])

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  index('push_subscriptions_user_id_idx').on(table.userId),
])

export const notificationOutbox = sqliteTable('notification_outbox', {
  eventId: text('event_id').notNull(),
  subscriptionId: text('subscription_id').notNull().references(() => pushSubscriptions.id, { onDelete: 'cascade' }),
  recipientId: text('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['mention', 'dm_message', 'huddle_started'] }).notNull(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  payloadJson: text('payload_json').notNull(),
  attempts: integer('attempts').notNull().default(0),
  availableAt: text('available_at').notNull(),
  leaseToken: text('lease_token'),
  leaseUntil: text('lease_until'),
  deliveredAt: text('delivered_at'),
  failedAt: text('failed_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.eventId, table.subscriptionId] }),
  index('notification_outbox_due_idx').on(table.availableAt).where(sql`${table.deliveredAt} is null and ${table.failedAt} is null`),
  check('notification_outbox_kind_check', sql`${table.kind} in ('mention', 'dm_message', 'huddle_started')`),
])

/** Cloudflare-managed mail domains attached to this single-workspace installation. */
export const emailDomains = sqliteTable('email_domains', {
  id: text('id').primaryKey().default('main'),
  zoneId: text('zone_id').notNull(),
  domain: text('domain').notNull(),
  appHostname: text('app_hostname').notNull(),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('email_domains_domain_unique').on(table.domain),
])

/** A mailbox is a private channel. Its email conversation channels are ordinary threads. */
export const emailMailboxes = sqliteTable('email_mailboxes', {
  channelId: text('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  domainId: text('domain_id').notNull().references(() => emailDomains.id, { onDelete: 'cascade' }),
  localPart: text('local_part').notNull(),
  displayName: text('display_name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('email_mailboxes_address_unique').on(table.domainId, table.localPart),
  check('email_mailboxes_local_part_check', sql`${table.localPart} = lower(${table.localPart}) and length(${table.localPart}) between 1 and 64`),
])

export const emailMailboxAccess = sqliteTable('email_mailbox_access', {
  channelId: text('channel_id').notNull().references(() => emailMailboxes.channelId, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  permission: text('permission', { enum: ['read', 'send', 'manage'] }).notNull().default('read'),
  ...isoTimestamps(),
}, table => [
  primaryKey({ columns: [table.channelId, table.userId] }),
  index('email_mailbox_access_user_idx').on(table.userId),
  check('email_mailbox_access_permission_check', sql`${table.permission} in ('read', 'send', 'manage')`),
])

export const emailThreads = sqliteTable('email_threads', {
  channelId: text('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  mailboxChannelId: text('mailbox_channel_id').notNull().references(() => emailMailboxes.channelId, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  status: text('status', { enum: ['inbox', 'archive', 'spam', 'trash'] }).notNull().default('inbox'),
  participantsJson: text('participants_json').notNull().default('[]'),
  lastMessageAt: text('last_message_at').notNull(),
  ...isoTimestamps(),
}, table => [
  index('email_threads_mailbox_status_latest_idx').on(table.mailboxChannelId, table.status, table.lastMessageAt),
  check('email_threads_status_check', sql`${table.status} in ('inbox', 'archive', 'spam', 'trash')`),
])

/** Protocol metadata extending a normal L4 message. Internal notes have no row here. */
export const emailMessages = sqliteTable('email_messages', {
  messageId: text('message_id').primaryKey().references(() => messages.id, { onDelete: 'cascade' }),
  threadChannelId: text('thread_channel_id').notNull().references(() => emailThreads.channelId, { onDelete: 'cascade' }),
  direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
  fromAddress: text('from_address').notNull(),
  fromName: text('from_name'),
  toJson: text('to_json').notNull().default('[]'),
  ccJson: text('cc_json').notNull().default('[]'),
  bccJson: text('bcc_json').notNull().default('[]'),
  rfcMessageId: text('rfc_message_id'),
  inReplyTo: text('in_reply_to'),
  referencesJson: text('references_json').notNull().default('[]'),
  deliveryStatus: text('delivery_status', { enum: ['received', 'pending', 'sent', 'failed'] }).notNull().default('received'),
  rawR2Key: text('raw_r2_key'),
  createdAt: text('created_at').notNull(),
  /** The mailbox that received or sent it; Message-IDs are unique within a mailbox. */
  mailboxChannelId: text('mailbox_channel_id').references(() => emailMailboxes.channelId, { onDelete: 'cascade' }),
  /** Outbound sender request key, or the raw SHA-256 of an inbound message that has no RFC Message-ID. Unique within a mailbox, so a retry is not stored twice. */
  clientRequestId: text('client_request_id'),
  deliveryAttempts: integer('delivery_attempts').notNull().default(0),
  deliveryError: text('delivery_error'),
  deliveredAt: text('delivered_at'),
}, table => [
  uniqueIndex('email_messages_mailbox_rfc_message_id_unique').on(table.mailboxChannelId, table.rfcMessageId).where(sql`${table.rfcMessageId} is not null`),
  uniqueIndex('email_messages_mailbox_client_request_unique').on(table.mailboxChannelId, table.clientRequestId).where(sql`${table.clientRequestId} is not null`),
  index('email_messages_thread_created_idx').on(table.threadChannelId, table.createdAt),
  check('email_messages_direction_check', sql`${table.direction} in ('inbound', 'outbound')`),
  check('email_messages_delivery_status_check', sql`${table.deliveryStatus} in ('received', 'pending', 'sent', 'failed')`),
])

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').notNull().references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  metaJson: text('meta_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
}, table => [
  index('audit_log_created_at_idx').on(table.createdAt),
  index('audit_log_actor_id_idx').on(table.actorId),
])

/** User-created databases are logical collections inside the installation D1. */
export const databaseDefinitions = sqliteTable('database_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  archivedAt: text('archived_at'),
  ...isoTimestamps(),
}, table => [
  index('database_definitions_position_idx').on(table.position),
])

/** A field maps a human name and type onto one whitelisted database_items slot. */
export const databaseFields = sqliteTable('database_fields', {
  id: text('id').primaryKey(),
  databaseId: text('database_id').notNull().references(() => databaseDefinitions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type', { enum: ['text', 'number', 'boolean', 'date', 'select'] }).notNull(),
  slot: text('slot').notNull(),
  configJson: text('config_json').notNull().default('{}'),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('database_fields_name_unique').on(table.databaseId, table.name),
  uniqueIndex('database_fields_slot_unique').on(table.databaseId, table.type, table.slot),
  index('database_fields_position_idx').on(table.databaseId, table.position),
  check('database_fields_type_check', sql`${table.type} in ('text', 'number', 'boolean', 'date', 'select')`),
])

/** Scalar custom fields use bounded typed slots; semantic names stay in database_fields. */
export const databaseItems = sqliteTable('database_items', {
  id: text('id').primaryKey(),
  databaseId: text('database_id').notNull().references(() => databaseDefinitions.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  position: integer('position').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id),
  text1: text('text_1'),
  text2: text('text_2'),
  text3: text('text_3'),
  text4: text('text_4'),
  text5: text('text_5'),
  text6: text('text_6'),
  text7: text('text_7'),
  text8: text('text_8'),
  text9: text('text_9'),
  text10: text('text_10'),
  text11: text('text_11'),
  text12: text('text_12'),
  text13: text('text_13'),
  text14: text('text_14'),
  text15: text('text_15'),
  text16: text('text_16'),
  number1: real('number_1'),
  number2: real('number_2'),
  number3: real('number_3'),
  number4: real('number_4'),
  number5: real('number_5'),
  number6: real('number_6'),
  number7: real('number_7'),
  number8: real('number_8'),
  boolean1: integer('boolean_1', { mode: 'boolean' }),
  boolean2: integer('boolean_2', { mode: 'boolean' }),
  boolean3: integer('boolean_3', { mode: 'boolean' }),
  boolean4: integer('boolean_4', { mode: 'boolean' }),
  boolean5: integer('boolean_5', { mode: 'boolean' }),
  boolean6: integer('boolean_6', { mode: 'boolean' }),
  boolean7: integer('boolean_7', { mode: 'boolean' }),
  boolean8: integer('boolean_8', { mode: 'boolean' }),
  date1: text('date_1'),
  date2: text('date_2'),
  date3: text('date_3'),
  date4: text('date_4'),
  date5: text('date_5'),
  date6: text('date_6'),
  date7: text('date_7'),
  date8: text('date_8'),
  select1: text('select_1'),
  select2: text('select_2'),
  select3: text('select_3'),
  select4: text('select_4'),
  select5: text('select_5'),
  select6: text('select_6'),
  select7: text('select_7'),
  select8: text('select_8'),
  ...isoTimestamps(),
}, table => [
  index('database_items_database_position_idx').on(table.databaseId, table.position),
  check('database_items_version_check', sql`${table.version} > 0`),
])

/** A shared, named lens over one Database. Config refers to semantic Field ids only. */
export const databaseViews = sqliteTable('database_views', {
  id: text('id').primaryKey(),
  databaseId: text('database_id').notNull().references(() => databaseDefinitions.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  layout: text('layout', { enum: ['table', 'board', 'calendar', 'list'] }).notNull().default('table'),
  configJson: text('config_json').notNull().default('{"visibleFieldIds":null,"filters":[],"sorts":[{"fieldId":"title","direction":"asc"}],"groupFieldId":null,"dateFieldId":null}'),
  position: integer('position').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('database_views_name_unique').on(table.databaseId, table.name),
  index('database_views_database_position_idx').on(table.databaseId, table.position),
  check('database_views_layout_check', sql`${table.layout} in ('table', 'board', 'calendar', 'list')`),
  check('database_views_version_check', sql`${table.version} > 0`),
])

/** Rich-text documents are durable workspace data. */
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  position: integer('position').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  index('documents_position_idx').on(table.position),
  check('documents_version_check', sql`${table.version} > 0`),
])

export const canvases = sqliteTable('canvases', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  position: integer('position').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  index('canvases_position_idx').on(table.position),
  check('canvases_version_check', sql`${table.version} > 0`),
])

export const canvasNodes = sqliteTable('canvas_nodes', {
  id: text('id').primaryKey(),
  canvasId: text('canvas_id').notNull().references(() => canvases.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['note', 'text'] }).notNull().default('note'),
  content: text('content').notNull().default(''),
  x: real('x').notNull().default(0),
  y: real('y').notNull().default(0),
  width: real('width').notNull().default(240),
  height: real('height').notNull().default(144),
  color: text('color', { enum: ['neutral', 'orange', 'blue', 'green', 'red'] }).notNull().default('neutral'),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  index('canvas_nodes_canvas_idx').on(table.canvasId, table.createdAt),
  check('canvas_nodes_kind_check', sql`${table.kind} in ('note', 'text')`),
  check('canvas_nodes_color_check', sql`${table.color} in ('neutral', 'orange', 'blue', 'green', 'red')`),
  check('canvas_nodes_version_check', sql`${table.version} > 0`),
])

export const canvasEdges = sqliteTable('canvas_edges', {
  id: text('id').primaryKey(),
  canvasId: text('canvas_id').notNull().references(() => canvases.id, { onDelete: 'cascade' }),
  fromNodeId: text('from_node_id').notNull().references(() => canvasNodes.id, { onDelete: 'cascade' }),
  toNodeId: text('to_node_id').notNull().references(() => canvasNodes.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [
  uniqueIndex('canvas_edges_nodes_unique').on(table.canvasId, table.fromNodeId, table.toNodeId),
  index('canvas_edges_canvas_idx').on(table.canvasId, table.createdAt),
  check('canvas_edges_not_self_check', sql`${table.fromNodeId} <> ${table.toNodeId}`),
])

/** Private, cross-device shortcuts. Target existence is checked at the API boundary. */
export const dataBookmarks = sqliteTable('data_bookmarks', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetType: text('target_type', { enum: ['database_view', 'document', 'canvas'] }).notNull(),
  targetId: text('target_id').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, table => [
  primaryKey({ columns: [table.userId, table.targetType, table.targetId] }),
  index('data_bookmarks_user_position_idx').on(table.userId, table.position, table.createdAt),
  check('data_bookmarks_target_type_check', sql`${table.targetType} in ('database_view', 'document', 'canvas')`),
])

/** Declarative internal tools. Drafts are mutable; published versions are immutable snapshots. */
export const gadgets = sqliteTable('gadgets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  draftSpecJson: text('draft_spec_json').notNull(),
  draftRevision: integer('draft_revision').notNull().default(1),
  publishedVersion: integer('published_version'),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  index('gadgets_position_idx').on(table.position, table.createdAt),
  check('gadgets_draft_revision_check', sql`${table.draftRevision} > 0`),
  check('gadgets_published_version_check', sql`${table.publishedVersion} is null or ${table.publishedVersion} > 0`),
])

export const gadgetVersions = sqliteTable('gadget_versions', {
  id: text('id').primaryKey(),
  gadgetId: text('gadget_id').notNull().references(() => gadgets.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  specJson: text('spec_json').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('gadget_versions_number_unique').on(table.gadgetId, table.version),
  check('gadget_versions_version_check', sql`${table.version} > 0`),
])

/** Mutable draft access. Publishing copies it into the immutable Version access list. */
export const gadgetDraftRoleAccess = sqliteTable('gadget_draft_role_access', {
  gadgetId: text('gadget_id').notNull().references(() => gadgets.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
}, table => [
  primaryKey({ columns: [table.gadgetId, table.roleId] }),
  index('gadget_draft_role_access_role_idx').on(table.roleId, table.gadgetId),
])

/** Role access captured for one immutable published Gadget Version. */
export const gadgetVersionRoleAccess = sqliteTable('gadget_version_role_access', {
  gadgetVersionId: text('gadget_version_id').notNull().references(() => gadgetVersions.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
}, table => [
  primaryKey({ columns: [table.gadgetVersionId, table.roleId] }),
  index('gadget_version_role_access_role_idx').on(table.roleId, table.gadgetVersionId),
])

/** Task boards are shared product state, so they live in D1 rather than an Agent DO. */
export const taskBoards = sqliteTable('task_boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  archivedAt: text('archived_at'),
  ...isoTimestamps(),
}, table => [
  index('task_boards_position_idx').on(table.position),
])

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => taskBoards.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status', { enum: ['backlog', 'ready', 'review', 'done', 'failed'] }).notNull().default('backlog'),
  priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] }).notNull().default('normal'),
  dueAt: text('due_at'),
  position: integer('position').notNull().default(0),
  /** Retired in migration 0027: it references agents only. Always NULL; use `assigneeUserId`. */
  assigneeId: text('assignee_id').references(() => agents.userId, { onDelete: 'set null' }),
  /** The member responsible for the task, human or agent. */
  assigneeUserId: text('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
  channelId: text('channel_id').references(() => channels.id, { onDelete: 'set null' }),
  /** Hidden channel holding the task's discussion, created on first use. */
  discussionChannelId: text('discussion_channel_id').references(() => channels.id, { onDelete: 'set null' }),
  createdBy: text('created_by').notNull().references(() => users.id),
  resultSummary: text('result_summary'),
  resultDetails: text('result_details'),
  lastError: text('last_error'),
  archivedAt: text('archived_at'),
  ...isoTimestamps(),
}, table => [
  index('tasks_board_status_position_idx').on(table.boardId, table.status, table.position),
  index('tasks_assignee_id_idx').on(table.assigneeId),
  index('tasks_assignee_user_id_idx').on(table.assigneeUserId),
  uniqueIndex('tasks_discussion_channel_unique').on(table.discussionChannelId).where(sql`${table.discussionChannelId} is not null`),
  check('tasks_status_check', sql`${table.status} in ('backlog', 'ready', 'review', 'done', 'failed')`),
  check('tasks_priority_check', sql`${table.priority} in ('low', 'normal', 'high', 'urgent')`),
])

/** Human-readable task numbers are database-assigned while UUIDs remain stable internal keys. */
export const taskNumbers = sqliteTable('task_numbers', {
  taskId: text('task_id').primaryKey().references(() => tasks.id, { onDelete: 'cascade' }),
  number: integer('number').notNull().unique(),
})

export const taskNumberSequence = sqliteTable('task_number_sequence', {
  id: integer('id').primaryKey(),
  nextNumber: integer('next_number').notNull(),
}, table => [
  check('task_number_sequence_singleton_check', sql`${table.id} = 1`),
  check('task_number_sequence_next_check', sql`${table.nextNumber} > 0`),
])

export const taskLabels = sqliteTable('task_labels', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => taskBoards.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('neutral'),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  uniqueIndex('task_labels_board_name_unique').on(table.boardId, table.name),
  index('task_labels_board_position_idx').on(table.boardId, table.position),
])

export const taskLabelLinks = sqliteTable('task_label_links', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  labelId: text('label_id').notNull().references(() => taskLabels.id, { onDelete: 'cascade' }),
}, table => [
  primaryKey({ columns: [table.taskId, table.labelId] }),
  index('task_label_links_label_idx').on(table.labelId),
])

export const taskDependencies = sqliteTable('task_dependencies', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOnTaskId: text('depends_on_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
  index('task_dependencies_depends_on_idx').on(table.dependsOnTaskId),
  check('task_dependencies_not_self_check', sql`${table.taskId} <> ${table.dependsOnTaskId}`),
])

export const taskChecklistItems = sqliteTable('task_checklist_items', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => users.id),
  ...isoTimestamps(),
}, table => [
  index('task_checklist_items_task_position_idx').on(table.taskId, table.position),
])

export const taskAttachments = sqliteTable('task_attachments', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  uploaderId: text('uploader_id').notNull().references(() => users.id),
  r2Key: text('r2_key').notNull().unique(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  width: integer('width'),
  height: integer('height'),
  createdAt: text('created_at').notNull(),
}, table => [
  index('task_attachments_task_created_idx').on(table.taskId, table.createdAt),
  check('task_attachments_size_check', sql`${table.sizeBytes} > 0`),
])

export const schema = {
  identityKeys,
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  authSettings,
  authProviderCredentials,
  onboardingRevisions,
  onboardingAcceptances,
  users,
  agents,
  agentTurns,
  workspace,
  mcpAccessTokens,
  roles,
  channelCategories,
  channels,
  scheduledHuddles,
  channelRoleOverrides,
  channelMembers,
  messages,
  channelReads,
  invites,
  attachments,
  messageReactions,
  messagePins,
  messageMentions,
  pushSubscriptions,
  notificationOutbox,
  emailDomains,
  emailMailboxes,
  emailMailboxAccess,
  emailThreads,
  emailMessages,
  auditLog,
  databaseDefinitions,
  databaseFields,
  databaseItems,
  databaseViews,
  documents,
  canvases,
  canvasNodes,
  canvasEdges,
  dataBookmarks,
  taskBoards,
  tasks,
  taskNumbers,
  taskNumberSequence,
  taskLabels,
  taskLabelLinks,
  taskDependencies,
  taskChecklistItems,
  taskAttachments,
}

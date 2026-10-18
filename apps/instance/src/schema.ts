import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const user = sqliteTable('auth_users', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false), image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(), updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
export const session = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(), expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(), updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'), userAgent: text('user_agent'),
})
export const account = sqliteTable('auth_accounts', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(), providerId: text('provider_id').notNull(), password: text('password'),
  accessToken: text('access_token'), refreshToken: text('refresh_token'), idToken: text('id_token'), scope: text('scope'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }), refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(), updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
export const verification = sqliteTable('auth_verifications', {
  id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(), createdAt: integer('created_at', { mode: 'timestamp_ms' }), updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
})

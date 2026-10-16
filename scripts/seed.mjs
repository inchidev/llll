import { spawnSync } from 'node:child_process'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import { uuidv7 } from 'uuidv7'
import { writeFileSync, unlinkSync } from 'node:fs'

const password = process.env.SEED_PASSWORD || 'password12'
const salt = randomBytes(16)
const key = await scryptAsync(password, salt, { N: 16384, r: 8, p: 1, dkLen: 32 })
const hash = `scrypt$16384$8$1$${bytesToHex(salt)}$${bytesToHex(key)}`

const ownerId = uuidv7()
const memberId = uuidv7()
const ownerAccountId = uuidv7()
const memberAccountId = uuidv7()
const workspaceId = 'main'
const ownerRole = uuidv7()
const memberRole = uuidv7()
const adminRole = uuidv7()
const generalId = uuidv7()
const now = new Date().toISOString()
const authNow = Date.now()

const sql = `
INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at) VALUES
  ('${ownerId}', 'Owner', 'owner@local.test', 1, ${authNow}, ${authNow}),
  ('${memberId}', 'Member', 'member@local.test', 1, ${authNow}, ${authNow});
INSERT INTO auth_accounts (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at) VALUES
  ('${ownerAccountId}', 'local:credential', '${ownerId}', 'credential', '${ownerId}', '${hash}', ${authNow}, ${authNow}),
  ('${memberAccountId}', 'local:credential', '${memberId}', 'credential', '${memberId}', '${hash}', ${authNow}, ${authNow});
INSERT INTO roles (id, key, name, permissions_bitmask, position, is_system, created_at, updated_at) VALUES
  ('${ownerRole}', 'owner', 'owner', 4095, 0, 1, '${now}', '${now}'),
  ('${adminRole}', 'admin', 'admin', 4095, 1, 1, '${now}', '${now}'),
  ('${memberRole}', 'member', 'member', 112, 2, 1, '${now}', '${now}');
INSERT INTO users (id, handle, display_name, status, role_id, joined_at, created_at, updated_at) VALUES
  ('${ownerId}', 'owner', 'Owner', 'active', '${ownerRole}', '${now}', '${now}', '${now}'),
  ('${memberId}', 'member', 'Member', 'active', '${memberRole}', '${now}', '${now}', '${now}');
INSERT INTO workspace (id, name, owner_id, created_at, updated_at) VALUES ('${workspaceId}', 'Local', '${ownerId}', '${now}', '${now}');
INSERT INTO channels (id, name, topic, type, visibility, position, created_at, updated_at) VALUES
  ('${generalId}', 'general', '', 'text', 'workspace', 0, '${now}', '${now}');
`

const file = 'scripts/.seed.sql'
writeFileSync(file, sql)
const r = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '-c', 'wrangler.dev.jsonc', `--file=${file}`], { stdio: 'inherit' })
unlinkSync(file)
if (r.status !== 0) process.exit(r.status ?? 1)
console.log('Seeded owner@local.test / member@local.test password:', password)

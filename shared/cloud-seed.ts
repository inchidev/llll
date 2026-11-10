import { z } from 'zod'
import { MCP_SCOPES } from './mcp'
import { egressHost } from './project-factory'

/**
 * What L4 Cloud asks the first claim to create besides the Owner (ADR 0012), as `server_setup.seed_json`
 * holds it. The control plane writes it through `seedNewServer` (`packages/deployment-core/src/deploy.ts`);
 * the Server reads it once, when the Owner is created, and the row goes with the claim.
 */
export const memberIdentitySchema = z.object({
  provider: z.string().trim().min(1).max(64),
  subject: z.string().trim().min(1).max(200),
}).strict()
export type MemberIdentity = z.infer<typeof memberIdentitySchema>

const secretName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u)

export const seedAgentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** A Role key, `admin` by the contract. */
  role: z.string().trim().min(1).max(64),
  /**
   * The token the Agent already holds, on the agent door: only its SHA-256 hex, its shown prefix and its scopes reach
   * the Server. A partner's Agent has none; it is woken from the Server.
   */
  token: z.object({
    hash: z.string().regex(/^[0-9a-f]{64}$/u),
    prefix: z.string().min(1).max(14),
    scopes: z.array(z.string().min(1).max(40)).max(40),
  }).strict().optional(),
  /** As long as a partner's contract allows; the editor's own limit is the form's, not the table's. */
  instructions: z.string().max(200_000).default(''),
  /** Grows when the partner changes the instructions; `agents/upsert` replaces them only then. */
  version: z.number().int().min(1).default(1),
}).strict()
export type SeedAgent = z.infer<typeof seedAgentSchema>

export const partnerSecretsSchema = z.record(secretName, z.object({
  value: z.string().min(1).max(8192),
  /** The hosts a Project may reach with it; no hosts means the secret alone. */
  hosts: z.array(z.string().trim().min(1).max(253)).max(32).default([]),
}).strict()).default({})
export const partnerEnvSchema = z.record(secretName, z.string().max(4096)).default({})
/** The most hosts a partner opens for its game Projects without a secret. */
export const PARTNER_HOSTS = 20
/**
 * Hosts a partner opens in its game Projects' network with no secret, such as a package CDN: public DNS names
 * only, as a Project's own hosts are (no IP address, port, wildcard or local name).
 */
export const partnerHostList = z.array(egressHost).max(PARTNER_HOSTS).transform(hosts => [...new Set(hosts)])
export const partnerHostsSchema = partnerHostList.default([])

export const cloudSeedSchema = z.object({
  owner: z.object({
    identity: memberIdentitySchema.optional(),
    name: z.string().trim().max(80).optional(),
    username: z.string().trim().max(32).optional(),
  }).strict().optional(),
  agent: seedAgentSchema.optional(),
  secrets: partnerSecretsSchema,
  env: partnerEnvSchema,
  /** From L4 0.0.28; an earlier Server refuses a seed that has it. */
  hosts: partnerHostsSchema,
}).strict()
export type CloudSeed = z.infer<typeof cloudSeedSchema>

/** The scopes a seeded token gets: the seed's, as far as they are scopes this Server knows; none means the default set. */
export function seedTokenScopes(scopes: readonly string[]) {
  return MCP_SCOPES.filter(scope => scopes.includes(scope))
}

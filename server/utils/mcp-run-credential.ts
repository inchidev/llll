import { MCP_DEFAULT_TOKEN_SCOPES, type McpScope } from '../../shared/mcp'
import type { L4Env } from '../../workers/env'

/**
 * A Run credential: the bearer token an external Agent's webhook carries for one Run. It authenticates
 * as the Agent for exactly that Run, so every tool call is authorized like the Run itself: the Agent's
 * Role and the permissions of the person who asked. It is stateless, signed with the Server secret,
 * and stops working when the Run closes or its reply window ends.
 */
const PREFIX = 'dfrun_'
export const RUN_CREDENTIAL_PATTERN = /^dfrun_([0-9a-f-]{36})_([0-9a-f]{64})$/u
/** What a token created without explicit scopes carries; the Run's own authority caps it further. */
export const RUN_CREDENTIAL_SCOPES: McpScope[] = MCP_DEFAULT_TOKEN_SCOPES

export function runCredentialId(runId: string): string {
  return `run:${runId}`
}
/** The Run a credential ID names, or null for any other credential. */
export function runIdOfCredential(credentialId: string | undefined): string | null {
  return credentialId?.startsWith('run:') ? credentialId.slice(4) : null
}

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
async function key(env: Pick<L4Env, 'AUTH_SECRET'>, usage: 'sign' | 'verify') {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) return null
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

/** The credential for one Run, or null when the Server cannot sign one. Distinct from the box's gateway capability. */
export async function runMcpCredential(env: Pick<L4Env, 'AUTH_SECRET'>, runId: string): Promise<string | null> {
  const signing = await key(env, 'sign')
  if (!signing) return null
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', signing, new TextEncoder().encode(`agent-run-mcp:${runId}`)))
  return `${PREFIX}${runId}_${hex(signature)}`
}

/** The Run a well-formed, correctly signed credential names, or null. */
export async function verifyRunMcpCredential(env: Pick<L4Env, 'AUTH_SECRET'>, token: string): Promise<string | null> {
  const match = RUN_CREDENTIAL_PATTERN.exec(token)
  const verifying = match && await key(env, 'verify')
  if (!match || !verifying) return null
  const signature = Uint8Array.from(match[2]!.match(/../gu)!, byte => Number.parseInt(byte, 16))
  return await crypto.subtle.verify('HMAC', verifying, signature, new TextEncoder().encode(`agent-run-mcp:${match[1]!}`)) ? match[1]! : null
}

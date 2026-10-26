import { z } from 'zod'

export const factorySha = z.string().regex(/^[a-f0-9]{40}$/u)
export const factoryPath = z.string().min(1).max(400).refine(value => !value.startsWith('/') && !value.includes('\\') && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  && value.split('/').every(part => part && part !== '.' && part !== '..' && !['.git', '.github'].includes(part.toLowerCase())), 'Protected or invalid path')
export const workspaceRequest = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('bootstrap') }).strict(),
  z.object({ operation: z.literal('exec'), command: z.string().trim().min(1).max(8000), timeoutMs: z.number().int().min(1000).max(600000).default(30000),
    networkHosts: z.array(z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u)).max(5).default([]) }).strict(),
  z.object({ operation: z.literal('read'), path: factoryPath }).strict(),
  z.object({ operation: z.literal('write'), path: factoryPath, content: z.string().max(80000) }).strict(),
  z.object({ operation: z.literal('snapshot') }).strict(),
  z.object({ operation: z.literal('suspend') }).strict(),
  z.object({ operation: z.literal('release') }).strict(),
])
export const publishRequest = z.object({ operation: z.literal('publish'), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  title: z.string().trim().min(1).max(160), body: z.string().max(12000).default('') }).strict()
export const factoryRequest = z.union([workspaceRequest, publishRequest])
/** Object-root schema works with providers that cannot accept a union at a function's root. */
export const factoryToolSchema = z.object({
  operation: z.enum(['bootstrap','exec','read','write','snapshot','suspend','release','publish']),
  command: z.string().min(1).max(8000).optional().describe('Required only for exec. Run in the Task checkout.'),
  timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Exec timeout, default 30000 milliseconds.'),
  networkHosts: z.array(z.string()).max(5).optional().describe('Exec only. Exact HTTPS hostnames for human review; no egress by default.'),
  path: factoryPath.optional().describe('Required for read/write. Relative ordinary file path.'),
  content: z.string().max(80000).optional().describe('Required only for write.'),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional().describe('Required only for publish. Use the digest returned by snapshot.'),
  title: z.string().min(1).max(160).optional().describe('Required only for publish.'),
  body: z.string().max(12000).optional().describe('Publish description.'),
}).strict()
/** Providers need an object root. Ignore only advertised fields irrelevant to the selected operation. */
export function parseFactoryToolInput(input: unknown) {
  const advertised = factoryToolSchema.parse(input)
  const fields: Record<typeof advertised.operation, string[]> = {
    bootstrap: [], exec: ['command', 'timeoutMs', 'networkHosts'], read: ['path'], write: ['path', 'content'],
    snapshot: [], suspend: [], release: [], publish: ['snapshotDigest', 'title', 'body'],
  }
  return (advertised.operation === 'publish' ? publishRequest : workspaceRequest).parse(Object.fromEntries(Object.entries(advertised).filter(([key]) => key === 'operation' || fields[advertised.operation].includes(key))))
}
export type FactoryRequest = z.infer<typeof factoryRequest>
const gitIdentity = z.object({ name: z.string().min(1).max(200), email: z.string().min(1).max(200), date: z.string().min(1).max(80) }).strict()
const snapshotFile = z.object({ path: factoryPath, content: z.string().max(80000).nullable(), executable: z.boolean() }).strict()
export const factorySnapshot = z.object({ baseSha: factorySha, headSha: factorySha, treeSha: factorySha,
  commits: z.array(z.object({ sha: factorySha, tree: factorySha, parents: z.array(factorySha).min(1).max(1), message: z.string().max(12000), author: gitIdentity, committer: gitIdentity, files: z.array(snapshotFile).min(1).max(100) }).strict()).min(1).max(20),
  files: z.array(snapshotFile).min(1).max(100),
  diff: z.string().max(180000), evidence: z.array(z.object({ actionId: z.string(), command: z.string().max(8000), exitCode: z.number().int(), outputDigest: z.string() })).max(50),
}).strict()
export type FactorySnapshot = z.infer<typeof factorySnapshot>
export type FactoryAction = { computeImage: string; computeLimits: { cpu: number; memoryMiB: number; processes: number; timeoutMs: number }; diskBytes: number; workspaceRevision: number; id: string; workspaceId: string; runId: string; digest: string; request: FactoryRequest; status: string;
  expiresAt: string; decidedBy: string | null; decidedAt: string | null; result: unknown; createdAt: string }
export type ComputeNode = { id: string; name: string; enabled: boolean; capabilities: Record<string, unknown>; lastSeen: string | null }
export const dockerCapabilities = z.object({ diskBytes: z.literal(1073741824), docker: z.literal(true), durableDisk: z.literal(true), isolation: z.literal('shared-kernel'),
  image: z.string().regex(/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/u), maxParallel: z.literal(1), protocol: z.literal(1) }).strict()

export const cloudflareCapabilities = z.object({ provider: z.literal('cloudflare-containers'), diskBytes: z.number().int().min(1000000000).max(20000000000), docker: z.literal(false), durableDisk: z.literal(false),
  isolation: z.literal('container-vm'), image: z.string().regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/u), maxParallel: z.literal(1), protocol: z.literal(1),
  memoryMiB: z.number().int().min(256).max(12288), cpu: z.number().positive().max(4), processLimit: z.number().int().min(32).max(512), codeBytes: z.literal(500000000), timeoutMs: z.number().int().min(1000).max(600000),
}).strict()
export const computeCapabilities = z.union([dockerCapabilities, cloudflareCapabilities])

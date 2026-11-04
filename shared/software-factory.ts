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
/** The Agent's plan for this Task. Approving it lets the workspace operations it covers run without
 * one review each: up to `operations` of them, egress only to `networkHosts`. Publication still waits. */
export const planRequest = z.object({ operation: z.literal('plan'), summary: z.string().trim().min(1).max(4000),
  steps: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
  networkHosts: z.array(z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u)).max(5).default([]),
  operations: z.number().int().min(1).max(1000) }).strict()
export const factoryRequest = z.union([workspaceRequest, publishRequest, planRequest])
/** Object-root schema works with providers that cannot accept a union at a function's root. */
export const factoryToolSchema = z.object({
  operation: z.enum(['plan','bootstrap','exec','read','write','snapshot','suspend','release','publish']),
  command: z.string().min(1).max(8000).optional().describe('Required only for exec. Run in the Task checkout.'),
  timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Exec timeout, default 30000 milliseconds.'),
  networkHosts: z.array(z.string()).max(5).optional().describe('Exec or plan. Exact public HTTPS hostnames; Browse web permission is required. No egress by default.'),
  path: factoryPath.optional().describe('Required for read/write. Relative ordinary file path.'),
  content: z.string().max(80000).optional().describe('Required only for write.'),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional().describe('Required only for publish. Use the digest returned by snapshot.'),
  title: z.string().min(1).max(160).optional().describe('Required only for publish.'),
  body: z.string().max(12000).optional().describe('Publish description.'),
  summary: z.string().min(1).max(4000).optional().describe('Required only for plan. What you will change and how you will check it.'),
  steps: z.array(z.string().min(1).max(500)).min(1).max(30).optional().describe('Required only for plan. The concrete steps, in order.'),
  operations: z.number().int().min(1).max(1000).optional().describe('Required only for plan. How many workspace operations the plan needs at most.'),
}).strict()
/** Providers need an object root. Ignore only advertised fields irrelevant to the selected operation. */
export function parseFactoryToolInput(input: unknown) {
  const advertised = factoryToolSchema.parse(input)
  const fields: Record<typeof advertised.operation, string[]> = {
    bootstrap: [], exec: ['command', 'timeoutMs', 'networkHosts'], read: ['path'], write: ['path', 'content'],
    snapshot: [], suspend: [], release: [], publish: ['snapshotDigest', 'title', 'body'], plan: ['summary', 'steps', 'networkHosts', 'operations'],
  }
  return (advertised.operation === 'publish' ? publishRequest : advertised.operation === 'plan' ? planRequest : workspaceRequest).parse(Object.fromEntries(Object.entries(advertised).filter(([key]) => key === 'operation' || fields[advertised.operation].includes(key))))
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
export type FactoryAction = { approvalMode?: 'role' | 'plan' | 'review'; computeImage: string; computeLimits: { cpu: number; memoryMiB: number; processes: number; timeoutMs: number }; diskBytes: number; workspaceRevision: number; id: string; workspaceId: string; runId: string; digest: string; request: FactoryRequest; status: string;
  expiresAt: string; decidedBy: string | null; decidedAt: string | null; result: unknown; createdAt: string }
export type ComputeNode = { id: string; name: string; enabled: boolean; capabilities: Record<string, unknown>; lastSeen: string | null }
// Existing Nodes retain their 1 GiB disks; new Nodes allocate 10 GiB per Task.
export const dockerCapabilities = z.object({ provider: z.literal('lizard').optional(), diskBytes: z.union([z.literal(1073741824), z.literal(10737418240)]), docker: z.literal(true), durableDisk: z.literal(true), isolation: z.literal('shared-kernel'),
  image: z.string().regex(/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/u), maxParallel: z.literal(1), protocol: z.literal(1) }).strict()

export const cloudflareCapabilities = z.object({ provider: z.literal('cloudflare-containers'), diskBytes: z.number().int().min(1000000000).max(20000000000), docker: z.literal(false), durableDisk: z.literal(false),
  isolation: z.literal('container-vm'), image: z.string().regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/u), maxParallel: z.literal(1), protocol: z.literal(1),
  memoryMiB: z.number().int().min(256).max(12288), cpu: z.number().positive().max(4), processLimit: z.number().int().min(32).max(512), codeBytes: z.literal(500000000), timeoutMs: z.number().int().min(1000).max(600000),
}).strict()
export const computeCapabilities = z.union([dockerCapabilities, cloudflareCapabilities])

/** Artifacts repository names allow 2–63 characters. Two UUIDs do not fit. */
export function factoryRepositoryName(serverId: string, workspaceId: string) {
  const hex = (value: string) => value.replaceAll('-', '').slice(0, 20)
  return `l4${hex(serverId)}${hex(workspaceId)}`
}

export function factoryProbeRepositoryName(serverId: string, nonce: string) {
  const hex = (value: string) => value.replaceAll('-', '').slice(0, 12)
  return `l4probe${hex(serverId)}${hex(nonce)}`
}

/** Default policy does not echo the application image through inspect() unless start() was given one. An empty report is the approved image. A reported digest must match. */
export function factoryImageAccepted(reported: string | undefined, expected: string) {
  const digest = /sha256:[a-f0-9]{64}$/u
  const expectedDigest = expected.match(digest)?.[0]
  if (!expectedDigest) return false
  if (!reported) return true
  return reported.match(digest)?.[0] === expectedDigest
}

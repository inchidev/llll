import { z } from 'zod'
import { DEFAULT_BRANCH_PREFIX, egressHost, secretName } from './project-factory'

export const factorySha = z.string().regex(/^[a-f0-9]{40}$/u)
/**
 * The branch in the original repository a box publishes to: the Project's branch prefix and the box's id.
 * Only a Project whose Git flow is direct_push has its base branch written instead.
 */
export const boxBranch = (boxId: string, prefix = DEFAULT_BRANCH_PREFIX) => `${prefix}${boxId}`
/** What the Agent asks to publish: one commit of its box, by SHA. Git's hashes stand for its content. */
export const publishToolSchema = z.object({
  sha: factorySha.describe('The full 40-character SHA of the commit in the box’s checkout to publish, from git rev-parse HEAD. It must descend from the Task’s pinned base.'),
  title: z.string().trim().min(1).max(160).describe('The pull request title.'),
  body: z.string().max(12000).default('').describe('The pull request description: what changed and how you checked it.'),
}).strict()
/** The Agent's plan for this Task. In plan mode an approved plan covers the publications that follow it. */
export const planToolSchema = z.object({
  summary: z.string().trim().min(1).max(4000).describe('What you will change and how you will check it.'),
  steps: z.array(z.string().trim().min(1).max(500)).min(1).max(30).describe('The concrete steps, in order.'),
  hosts: z.array(egressHost).max(10).default([]).describe('Hosts beyond the Project’s network the work needs, such as api.telegram.org. Once the plan is approved, a window for one of them opens without asking again.'),
  secrets: z.array(secretName).max(10).default([]).describe('Names of Project secrets the work uses, such as TELEGRAM_TOKEN. In plan mode only the secrets an approved plan names are put in.'),
}).strict()
/** What the Agent asks to merge, where the Project's Git flow lets it: its pull request at the head it checked. */
export const mergeToolSchema = z.object({
  sha: factorySha.describe('The full SHA of the pull request head whose checks passed, as factory_feedback reports it in commit. A head that moved since is refused.'),
}).strict()
/** A person's merge from the Task: the head they saw. */
export const mergeRequestSchema = mergeToolSchema
/** A push's review as the Node or box produced it from Git, stored in R2 under the approval. */
export const reviewDiffSchema = z.object({ sha: factorySha, baseSha: factorySha,
  commits: z.array(z.object({ sha: factorySha, subject: z.string().max(500) }).strict()).max(200),
  stat: z.string().max(64000), patch: z.string().max(2000000), truncated: z.boolean() }).strict()
export type ReviewDiff = z.infer<typeof reviewDiffSchema>
export type FactoryApprovalKind = 'plan' | 'publish' | 'window' | 'merge'
/** An outward action of a box as a person reviewing it sees it. The diff itself is read from R2 on demand. */
export type FactoryApproval = { id: string; boxId: string; runId: string; kind: FactoryApprovalKind; digest: string; status: string
  request: { sha?: string; ref?: string; direct?: true; title?: string; body?: string; summary?: string; steps?: string[]; hosts?: string[]; host?: string; minutes?: number; secrets?: string[]; reason?: string
    number?: number; method?: string; by?: 'person' | 'agent' }
  /** The review a Node or box produced for a push, kept in R2: only its digest is on the row. */
  diff: { digest: string } | null
  decidedBy: string | null; decidedAt: string | null; expiresAt: string; result: unknown; createdAt: string }
export type ComputeNode = { id: string; name: string; enabled: boolean; capabilities: Record<string, unknown>; lastSeen: string | null }
/** The name the Server gives the Node it pairs on its own VPS host. */
export const LOCAL_NODE_NAME = 'Local VPS executor'
/**
 * A Node of an earlier release speaks protocol 1 and gets no work. What its Owner does about it: the Server's own
 * VPS Node is replaced in place from the release; any other Node is paired again with this release's Node.
 */
export function computeNodeUpdate(node: Pick<ComputeNode, 'name' | 'enabled' | 'capabilities'>) {
  if (!node.enabled || node.capabilities.protocol === 2) return null
  return node.name === LOCAL_NODE_NAME
    ? { local: true, text: 'This Node runs the Compute Node of an earlier release (protocol 1) and gets no work. On the Server’s VPS, run sudo llll compute enable --trust-shared-kernel. It replaces the Node in place with this release and keeps its pairing; llll upgrade does the same when it updates the Server.' }
    : { local: false, text: 'This Node runs the Compute Node of an earlier release (protocol 1) and gets no work. Stop its daemon, disable and revoke it here, then pair this release’s Node and box image with a new pairing code and select it for your repositories.' }
}
/** What a Node runs at once: the Server admits boxes while their reservations fit (server/utils/box-admission.ts). */
export const nodeCapacity = z.object({ cpu: z.number().positive().max(1024), memoryMiB: z.number().int().min(256).max(16777216), boxes: z.number().int().min(1).max(64) }).strict()
export type NodeCapacity = z.infer<typeof nodeCapacity>
// Existing Nodes retain their 1 GiB disks; new Nodes allocate 10 GiB per Task.
export const dockerCapabilities = z.object({ diskBytes: z.union([z.literal(1073741824), z.literal(10737418240)]), docker: z.literal(true), durableDisk: z.literal(true), isolation: z.literal('shared-kernel'),
  image: z.string().regex(/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/u), capacity: nodeCapacity, protocol: z.literal(2) }).strict()

/** `cpu` and `memoryMiB` size one container; `capacity` is that size times the containers the application may run. */
export const cloudflareCapabilities = z.object({ provider: z.literal('cloudflare-containers'), diskBytes: z.number().int().min(1000000000).max(20000000000), docker: z.literal(false), durableDisk: z.literal(false),
  isolation: z.literal('container-vm'), image: z.string().regex(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/u), capacity: nodeCapacity, protocol: z.literal(2),
  memoryMiB: z.number().int().min(256).max(12288), cpu: z.number().positive().max(4), processLimit: z.number().int().min(32).max(512), codeBytes: z.literal(500000000), timeoutMs: z.number().int().min(1000).max(600000),
}).strict()
export const computeCapabilities = z.union([dockerCapabilities, cloudflareCapabilities])
export type ComputeCapabilities = z.infer<typeof computeCapabilities>

/** Artifacts repository names allow 2–63 characters. Two UUIDs do not fit. */
export function factoryRepositoryName(serverId: string, boxId: string) {
  const hex = (value: string) => value.replaceAll('-', '').slice(0, 20)
  return `l4${hex(serverId)}${hex(boxId)}`
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

const FACTORY_STATES: Record<string, string> = { approval_pending: 'Waiting for review', publishing: 'Publishing', pr_published: 'Pull request open', publish_failed: 'Publication failed',
  rejected: 'Publication rejected', pushed: 'Pushed to the base branch', merged: 'Merged', merge_failed: 'Merge refused', ci_success: 'Checks passed', ci_failure: 'Checks failed', ci_running: 'Checks running', ci_absent: 'No checks yet', ci_unverified: 'Checks incomplete' }
/** A Task's code work as its board shows it. */
export const factoryStateLabel = (state: string) => FACTORY_STATES[state] ?? state.replaceAll('_', ' ')

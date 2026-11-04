import type { FactoryRequest, FactorySnapshot } from './software-factory'

/** Server-authorized operations; implementations never receive a Git write credential. */
export interface WorkspaceProvider {
  readonly capabilities: { durableDisk: boolean; isolation: 'shared-kernel' | 'vm'; maxParallel: number; diskBytes: number; image: string }
  execute(job: WorkspaceJob, signal: AbortSignal): Promise<WorkspaceReceipt>
}
export type WorkspaceJob = { id: string; serverId: string; workspaceId: string; taskId: string; agentId: string;
  baseSha: string; image: string; request: Exclude<FactoryRequest, { operation: 'publish' }> }
export type WorkspaceReceipt = { ok: boolean; exitCode: number; output: string; runtimeMs: number; snapshot?: FactorySnapshot }
// The outbound Node protocol implements this contract on both Cloudflare and VPS Servers.
// Pairing/leases live in the Server broker; providers implement only bounded workspace effects.

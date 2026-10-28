import type { RunStatus } from './agent-execution'

export type RunStatusColor = 'neutral' | 'info' | 'success' | 'error' | 'warning'

/** One color per Run status, shared by the Runs list and the Run page. */
export function runStatusColor(status: RunStatus | string | null | undefined): RunStatusColor {
  if (status === 'running') return 'info'
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'cancelled') return 'warning'
  return 'neutral'
}

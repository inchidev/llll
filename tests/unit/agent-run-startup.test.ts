import { expect, it, vi } from 'vitest'
import { AgentRunDurableObject } from '../../workers/agent-run-do'
import { AgentScheduleDurableObject } from '../../workers/agent-schedule-do'
import '../../server/utils/agent-gateway'

const loaded = vi.hoisted(() => vi.fn())
const toolsLoaded = vi.hoisted(() => vi.fn())
const schedulesLoaded = vi.hoisted(() => vi.fn())
const mcpLoaded = vi.hoisted(() => vi.fn())
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
vi.mock('../../workers/agent-pi-durable', () => {
  loaded()
  return { runEmbeddedPi: vi.fn() }
})
vi.mock('../../server/utils/agent-tools', () => {
  toolsLoaded()
  return { toolsForRun: vi.fn(), executeRunTool: vi.fn() }
})
vi.mock('../../server/utils/outbound-mcp', () => {
  mcpLoaded()
  return { mcpRunBrief: vi.fn(), mcpRunTools: vi.fn(), mcpToolExposure: vi.fn(), admitMcpConnections: vi.fn() }
})
vi.mock('../../server/utils/schedule-service', () => {
  schedulesLoaded()
  return { findSchedule: vi.fn(), executeScheduledOccurrence: vi.fn(), recordScheduleFailure: vi.fn() }
})

it('can load the exported coordinator without initialising the embedded Pi runtime', () => {
  expect(typeof AgentRunDurableObject).toBe('function')
  expect(loaded).not.toHaveBeenCalled()
})

it('does not load tool implementations when loading the coordinator and model gateway', () => {
  expect(toolsLoaded).not.toHaveBeenCalled()
  expect(mcpLoaded).not.toHaveBeenCalled()
})

it('loads the alarm class without initialising scheduling and calendar code', () => {
  expect(typeof AgentScheduleDurableObject).toBe('function')
  expect(schedulesLoaded).not.toHaveBeenCalled()
})

import type { RuntimeCapabilities } from '../shared/types'
import { emailInboundProvider } from './inbound-email'
import { authEmailAvailable, emailProvider } from './mail-transport'
import {
  aiProvider,
  browserProvider,
  callsProvider,
  type L4Env,
} from './env'

export const UNAVAILABLE_CAPABILITIES: RuntimeCapabilities = {
  calls: false,
  containers: false,
  browser: null,
  emailOutbound: false,
  emailInbound: null,
  emailProvider: null,
  callsProvider: null,
}

/** Containers are not part of this product on any runtime. */
export function containersAvailable(): boolean {
  return false
}

export function serverCapabilities(env: L4Env): RuntimeCapabilities {
  const calls = callsProvider(env)
  return {
    calls: calls !== null,
    containers: containersAvailable(),
    browser: browserProvider(env),
    emailOutbound: authEmailAvailable(env),
    emailInbound: emailInboundProvider(env),
    emailProvider: emailProvider(env),
    callsProvider: calls,
  }
}

export function serverAiModel(env: L4Env): string | null {
  const provider = aiProvider(env)
  if (provider === 'openai-compatible') return env.AI_MODEL?.trim() || null
  if (provider === 'workers-ai' || provider === 'workers-ai-rest') return env.AGENT_MODEL?.trim() || null
  return null
}

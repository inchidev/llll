/** What Pi and the model gateway are told about a Run's model. */
export type AgentModelLimits = { contextWindow: number; maxOutputTokens: number }
/** Where a limit came from: the provider's own report, the Owner's setting, Pi's catalog or the default. */
export type AgentModelLimitSource = 'reported' | 'owner' | 'catalog' | 'default'
export type AgentModelLimitDetails = AgentModelLimits & { sources: Record<keyof AgentModelLimits, AgentModelLimitSource> }
type LimitValues = { contextWindow?: number; maxOutputTokens?: number }

/**
 * Pi sends the whole retained context with every call, so a million-token window would spend a
 * Run's token budget in a few calls. Compaction keeps a long Run inside this ceiling instead.
 */
export const agentContextCeiling = 200_000
export const agentOutputCeiling = 32_000
/** An unknown model. Pi compacts when a provider reports an overflow, so a generous guess recovers. */
export const unknownModelLimits: AgentModelLimits = { contextWindow: 128_000, maxOutputTokens: 8_192 }

const positive = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

/**
 * A model's limits, each one from the first source that has it: what its provider reported, then what the Owner
 * set for a model whose provider did not, then Pi's catalog, then a generous default. The window is capped at the
 * ceiling above, and the answer at a quarter of the window.
 */
export function resolveModelLimits(sources: { reported?: LimitValues; owner?: LimitValues; catalog?: LimitValues }): AgentModelLimitDetails {
  const pick = (key: keyof AgentModelLimits): [number, AgentModelLimitSource] => {
    for (const source of ['reported', 'owner', 'catalog'] as const) {
      const value = positive(sources[source]?.[key])
      if (value) return [value, source]
    }
    return [unknownModelLimits[key], 'default']
  }
  const [window, windowSource] = pick('contextWindow'), [output, outputSource] = pick('maxOutputTokens')
  const contextWindow = Math.min(window, agentContextCeiling)
  return { contextWindow, maxOutputTokens: Math.max(1024, Math.min(output, agentOutputCeiling, Math.floor(contextWindow / 4))),
    sources: { contextWindow: windowSource, maxOutputTokens: outputSource } }
}

/** True when a limit the provider did not report could still come from the Owner. */
export function needsLimitSetting(reported: LimitValues | undefined) {
  return !positive(reported?.contextWindow) || !positive(reported?.maxOutputTokens)
}

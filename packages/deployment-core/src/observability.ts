export const workerObservability = {
  enabled: true,
  redact_query_string: true,
  logs: {
    enabled: true,
    invocation_logs: true,
    head_sampling_rate: 1,
    persist: true,
  },
  traces: {
    enabled: true,
    head_sampling_rate: 0.1,
    persist: true,
  },
} as const

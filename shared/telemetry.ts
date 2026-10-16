export type TelemetrySettingsDTO = {
  enabled: boolean
  available: boolean
}

export type TelemetryHeartbeat = {
  schemaVersion: 1
  installationId: string
  version: string
  sentAt: string
  capabilities: {
    d1: boolean
    r2: boolean
    kv: boolean
    customDomain: boolean
    email: boolean
    agents: boolean
    huddles: boolean
  }
}

import { z } from 'zod'

const https = (value: string) => { try { return ['http:', 'https:'].includes(new URL(value).protocol) && !new URL(value).username } catch { return false } }
const cdp = (value: string) => { try { return ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(value).protocol) } catch { return false } }
const secret = (min: number) => z.string().trim().min(min).max(4096)
const gateway = z.string().trim().max(2048).refine(https, 'Enter a complete http(s) URL')

/**
 * Settings an Owner can enter instead of a deployment variable. A deployment variable of the
 * same name wins, so nothing changes for an operator who already set one.
 */
export const integrationFields = {
  EXA_API_KEY: { schema: secret(8), secret: true },
  BROWSER_CDP_URL: { schema: z.string().trim().max(2048).refine(cdp, 'Enter an http(s) or ws(s) address'), secret: true },
  CLOUDFLARE_ACCOUNT_ID: { schema: z.string().trim().regex(/^[0-9a-f]{32}$/iu, 'An account ID has 32 hexadecimal characters'), secret: false },
  CLOUDFLARE_API_TOKEN: { schema: secret(32), secret: true },
  MAIL_GATEWAY_URL: { schema: gateway, secret: false },
  MAIL_GATEWAY_TOKEN: { schema: secret(8), secret: true },
  SMTP_GATEWAY_URL: { schema: gateway, secret: false },
  SMTP_GATEWAY_TOKEN: { schema: secret(8), secret: true },
  INBOUND_EMAIL_SECRET: { schema: secret(32), secret: true },
  POSTMARK_INBOUND_SECRET: { schema: secret(32), secret: true },
  MAILGUN_WEBHOOK_SIGNING_KEY: { schema: secret(32), secret: true },
  SES_SNS_TOPIC_ARN: { schema: z.string().trim().regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/u, 'Enter an Amazon SNS topic ARN'), secret: false },
} as const
export type IntegrationKey = keyof typeof integrationFields
export const integrationKeys = Object.keys(integrationFields) as IntegrationKey[]
/** What only makes sense where the Server is not already on Cloudflare's network. */
export const offCloudflareKeys: IntegrationKey[] = integrationKeys.filter(key => key !== 'EXA_API_KEY')

export type IntegrationFieldStatus = { source: 'deployment' | 'settings' | null; value: string | null }
export type IntegrationsDTO = {
  cloudflareNetwork: boolean
  fields: Partial<Record<IntegrationKey, IntegrationFieldStatus>>
  status: { search: 'exa' | 'openrouter' | null; pages: string | null; outbound: string | null; inbound: string | null; calls: string | null }
  webhooks: { bridge: string; postmark: string; mailgun: string; ses: string }
}

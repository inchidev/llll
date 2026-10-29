import { z } from 'zod'

/** Header names a webhook may carry its sender key in; never Host, Cookie or hop-by-hop headers. */
const headerName = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/u, 'Use letters, digits and hyphens')
  .refine(value => !['host', 'cookie', 'content-length', 'content-type', 'connection', 'transfer-encoding'].includes(value.toLowerCase()), 'Choose another header')

/** A public HTTPS destination. Local, private and IP-literal hosts never receive Run content. */
export function publicWebhookUrl(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || host.startsWith('[') || /^[0-9.]+$/u.test(host)) return false
  return !/(^|\.)(localhost|local|internal|lan|home|arpa|test|invalid)$/u.test(host)
}

export const agentWebhookInput = z.object({
  url: z.string().trim().max(2000).refine(publicWebhookUrl, 'Use a public https:// URL'),
  headerName: headerName.default('Authorization'),
  /** The sender key, sent exactly as entered. Omit to keep the saved key. */
  headerValue: z.string().trim().min(1).max(4000).optional(),
  replyTimeoutMinutes: z.number().int().min(2).max(120).default(20),
})
export type AgentWebhookInput = z.input<typeof agentWebhookInput>

export type AgentWebhookDTO = {
  url: string
  headerName: string
  hasHeaderValue: boolean
  replyTimeoutMinutes: number
  updatedAt: string
}

/** Body of every wake-up request. The receiver treats `prompt` as untrusted data. */
export type AgentWebhookPayload = {
  type: 'agent.run'
  version: 1
  runId: string
  deadline: string
  server: { id: string; origin: string | null; mcp: string | null }
  agent: { id: string; name: string }
  from: { id: string; name: string }
  conversation: { channelId: string; sourceMessageId: string | null; taskId: string | null }
  prompt: string
  reply: { tool: 'send_message'; arguments: { channelId: string } }
  /** Call once the work is done; intermediate messages keep the Run open. */
  complete: { tool: 'complete_run'; arguments: { runId: string } }
}

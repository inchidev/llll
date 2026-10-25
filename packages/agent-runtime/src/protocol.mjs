import { z } from 'zod'

export const runtimeInput = z.object({
  runId: z.string().uuid(), sessionId: z.string().uuid(),
  prompt: z.string().min(1).max(48000), instructions: z.string().max(16000),
  modelGateway: z.object({ url: z.string().url(), token: z.string().min(16), model: z.string().min(1).max(200) }),
  tools: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u), description: z.string().max(2000), parameters: z.record(z.string(), z.unknown()), deferred: z.boolean().optional() })).max(40),
  toolEndpoint: z.string().url(), transcript: z.string().max(2000000).nullable().optional(),
  repository: z.object({ archiveUrl: z.string().url() }).optional(), filesUrl: z.string().url().optional(),
  computer: z.boolean().default(false), maxSteps: z.number().int().min(1).max(100).default(20),
  timeoutMs: z.number().int().min(1000).max(1800000).default(300000),
}).strict()

import { z } from 'zod'

/**
 * The most tools a turn may carry. A box turn carries every tool the Agent may use, most of them deferred until
 * get_tool_details loads them, so this is the Server's whole catalog with room to grow, not what a model sees.
 */
export const MAX_RUNTIME_TOOLS = 120
/** The Server's own ceilings, so that every turn it may send is one the runtime takes: an execution policy's steps, and a partner Agent's instructions (200,000 characters in its seed) with the Server's run brief after them. */
export const MAX_RUNTIME_STEPS = 2048
export const MAX_RUNTIME_INSTRUCTIONS = 210000

export const runtimeInput = z.object({
  runId: z.string().uuid(), sessionId: z.string().uuid(),
  prompt: z.string().min(1).max(48000), instructions: z.string().max(MAX_RUNTIME_INSTRUCTIONS),
  modelGateway: z.object({ url: z.string().url(), token: z.string().min(16), model: z.string().min(1).max(200),
    // The model's own limits and the compaction thresholds the Server derived from them.
    contextWindow: z.number().int().min(1024).max(10000000).default(64000), maxOutputTokens: z.number().int().min(256).max(1000000).default(4096),
    compaction: z.object({ reserveTokens: z.number().int().min(0), keepRecentTokens: z.number().int().min(0), backgroundTokens: z.number().int().min(0) }).strict().optional() }).strict(),
  tools: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u), description: z.string().max(2000), parameters: z.record(z.string(), z.unknown()), deferred: z.boolean().optional() })).max(MAX_RUNTIME_TOOLS),
  toolEndpoint: z.string().url(), transcript: z.string().max(2000000).nullable().optional(),
  repository: z.object({ archiveUrl: z.string().url() }).optional(), filesUrl: z.string().url().optional(),
  // Pi's own shell, file and edit tools. They bypass the Server's per-call policy, so they run only on the
  // Task's box, whose boundary is the box and its egress layer (ADR 0011); anywhere else they are refused.
  computer: z.boolean().default(false), box: z.boolean().default(false),
  // Messages the person sent while the turn waited or ran; a box hears later ones from the Server.
  steering: z.array(z.object({ messageId: z.string().min(1).max(100), content: z.string().min(1).max(48000) }).strict()).max(20).optional(),
  maxSteps: z.number().int().min(1).max(MAX_RUNTIME_STEPS).default(20),
  timeoutMs: z.number().int().min(1000).max(1800000).default(300000),
}).strict().refine(input => input.computer === input.box, 'Native computer tools run only on the Task’s box')

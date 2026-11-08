import { z } from 'zod'

/**
 * L4 Compute (ADR 0009): a box per Task from llll.gg, paid by the hour of agent work. The Server chooses a
 * size per Project; prices live only on llll.gg, so nothing here quotes one.
 */
export const l4ComputeSizes = ['small', 'medium', 'large'] as const
export type L4ComputeSize = typeof l4ComputeSizes[number]
export const L4_COMPUTE_SIZE_LABELS: Record<L4ComputeSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' }
export const DEFAULT_L4_COMPUTE_SIZE: L4ComputeSize = 'small'
/** The compute part of `projects.factory_json`: the size of the Project's boxes on L4 Compute. */
export const projectComputeSchema = z.object({ size: z.enum(l4ComputeSizes).default(DEFAULT_L4_COMPUTE_SIZE) }).strict()
export type ProjectCompute = z.infer<typeof projectComputeSchema>
export const DEFAULT_PROJECT_COMPUTE: ProjectCompute = { size: DEFAULT_L4_COMPUTE_SIZE }
export function projectCompute(factoryJson: string | null | undefined): ProjectCompute {
  if (!factoryJson) return DEFAULT_PROJECT_COMPUTE
  try {
    const parsed = projectComputeSchema.safeParse((JSON.parse(factoryJson) as { compute?: unknown }).compute ?? DEFAULT_PROJECT_COMPUTE)
    return parsed.success ? parsed.data : DEFAULT_PROJECT_COMPUTE
  } catch { return DEFAULT_PROJECT_COMPUTE }
}

/** The name of the Server's placement Node for L4 Compute; each box gets a Node of its own under it. */
export const L4_COMPUTE_NODE_NAME = 'L4 Compute'
export const L4_COMPUTE_PRICING_URL = 'https://llll.gg/pricing'
export const L4_COMPUTE_ACCOUNT_URL = 'https://llll.gg/account'

/** What llll.gg reports about the account's credit; the Owner changes the limit there, the Server only shows it. */
export const l4ComputeStatusSchema = z.object({
  creditCents: z.number().int(), spentCents: z.number().int().min(0), limitCents: z.number().int().min(0).nullable().default(null), currency: z.string().min(3).max(3).default('USD'),
}).passthrough()
export type L4ComputeStatus = z.infer<typeof l4ComputeStatusSchema>

/** L4 Compute as Settings → Compute shows it. */
export type L4ComputeOverview = {
  /** This Server may ask llll.gg for boxes: linked by the Owner, or hosted on L4 Cloud. */
  linked: boolean
  /** Hosted on L4 Cloud: linked with its own identity, no connect or disconnect step. */
  hosted: boolean
  account: string | null
  linkedAt: string | null
  /** The connect step can start: the Server knows its public origin and is not hosted. */
  canConnect: boolean
  nodeId: string | null
  status: L4ComputeStatus | null
  /** Why there is no fresh status: llll.gg unreachable, or its answer unreadable. Local work never waits for it. */
  statusError: string | null
  statusAt: string | null
  boxes: { active: number; retained: number }
  pricingUrl: string
  accountUrl: string
}

export function formatCents(cents: number, currency = 'USD') {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(cents / 100) }
  catch { return `${(cents / 100).toFixed(2)} ${currency}` }
}

import { z } from 'zod'
export const githubSetupSchema = z.object({ name: z.string().trim().min(1).max(60), account: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u), organization: z.boolean().default(true) }).strict()
export type GitConnection = { id: string; name: string; provider: 'github'; host: string; account: string; appId: string; appSlug: string; enabled: boolean; setupUrl: string }

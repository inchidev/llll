import { z } from 'zod'
const githubAccount = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u)
/** A personal App needs no account: GitHub creates it for the signed-in user. Organizations appear in the URL. */
export const githubSetupSchema = z.object({ name: z.string().trim().min(1).max(34).optional(), account: githubAccount.optional(), organization: z.boolean().default(false) }).strict()
  .refine(input => !input.organization || input.account, { message: 'Organization name is required', path: ['account'] })
export type GitConnection = { id: string; name: string; provider: 'github'; host: string; account: string; appId: string; appSlug: string; enabled: boolean; setupUrl: string }

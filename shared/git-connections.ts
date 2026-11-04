import { z } from 'zod'
const githubAccount = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u)
/** A personal App needs no account: GitHub creates it for the signed-in user. Organizations appear in the URL. */
export const githubSetupSchema = z.object({ name: z.string().trim().min(1).max(34).optional(), account: githubAccount.optional(), organization: z.boolean().default(false) }).strict()
  .refine(input => !input.organization || input.account, { message: 'Organization name is required', path: ['account'] })
export type GitProvider = 'github' | 'gitea'
/** Gitea and Forgejo serve from an HTTPS origin; a sub-path install is not supported yet. */
export const giteaOrigin = z.string().trim().max(500).transform((value, context) => {
  let url: URL
  try { url = new URL(value) } catch { context.addIssue({ code: 'custom', message: 'Enter the HTTPS address of your Gitea' }); return z.NEVER }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/u, '') !== '') {
    context.addIssue({ code: 'custom', message: 'Use the HTTPS origin of your Gitea, for example https://git.example.com' }); return z.NEVER
  }
  return url.origin
})
/** A bot account's access token. Repository access is whatever that account can reach in Gitea. */
export const giteaConnectSchema = z.object({ host: giteaOrigin, token: z.string().trim().regex(/^[A-Za-z0-9_-]{20,200}$/u, 'Paste the access token Gitea showed once'), name: z.string().trim().min(1).max(80).optional() }).strict()
export type GitConnection = { id: string; name: string; provider: GitProvider; host: string; account: string; appId: string; appSlug: string; enabled: boolean; setupUrl: string }

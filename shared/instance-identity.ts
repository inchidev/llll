import { SignJWT, jwtVerify } from 'jose'
import { z } from 'zod'

const identitySchema = z.object({
  sub: z.string().min(1).max(200), name: z.string().min(1).max(100), email: z.string().email().max(200),
  role: z.enum(['owner', 'member']), sessionId: z.string().min(1).max(200),
})
export type InstallationIdentity = z.infer<typeof identitySchema>

export async function signInstallationIdentity(identity: InstallationIdentity, secret: string, issuer: string, serverId: string) {
  if (secret.length < 32) throw new Error('Server connection key is unavailable')
  return new SignJWT(identity).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(issuer).setAudience(serverId).setIssuedAt().setExpirationTime('30s').sign(new TextEncoder().encode(secret))
}

export async function verifyInstallationIdentity(token: string, secret: string, issuer: string, serverId: string): Promise<InstallationIdentity> {
  if (secret.length < 32) throw new Error('Server connection key is unavailable')
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { issuer, audience: serverId, algorithms: ['HS256'], maxTokenAge: '30s' })
  return identitySchema.parse(payload)
}

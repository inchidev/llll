import type { L4Env } from '../../workers/env'

export type OwnerSetup = {
  email: string
  token: string
  workspaceName: string
}

export function readOwnerSetupEnv(env: Pick<L4Env, 'ADMIN_EMAIL' | 'ADMIN_SETUP_TOKEN' | 'ADMIN_WORKSPACE' | 'APP_NAME'>): OwnerSetup | null {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase() || ''
  const token = env.ADMIN_SETUP_TOKEN?.trim() || ''
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || token.length < 32) return null
  return {
    email,
    token,
    workspaceName: (env.ADMIN_WORKSPACE?.trim() || env.APP_NAME?.trim() || 'L4').slice(0, 80),
  }
}

export function ownerSetupTokenMatches(expected: string, actual: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(expected)
  const right = encoder.encode(actual)
  let mismatch = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return mismatch === 0
}

export function verifiedOwnerSetupEmail(setup: OwnerSetup | null, token: string): string | null {
  if (!setup || !ownerSetupTokenMatches(setup.token, token)) return null
  return setup.email
}

export function maskedOwnerEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  const visible = local.slice(0, 1)
  return `${visible}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`
}

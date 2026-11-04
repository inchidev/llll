const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** Cloudflare's documented test secrets answer for example.com with no action, so only those two checks are skipped for them. */
const TEST_SECRET = /^[123]x0{20,}A{2}$/u

/** Checks one Turnstile token. Any failure to reach Cloudflare counts as not passing. */
export async function verifyTurnstile(secret: string, token: string, ip: string, hostnames: string[], action = 'signup'): Promise<boolean> {
  try {
    const response = await fetch(SITEVERIFY, {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, ...(ip !== 'unknown' ? { remoteip: ip } : {}) }),
    })
    const result = await response.json() as { success?: boolean; action?: string; hostname?: string }
    if (!result.success) return false
    return TEST_SECRET.test(secret) || (result.action === action && hostnames.includes(result.hostname ?? ''))
  }
  catch {
    return false
  }
}

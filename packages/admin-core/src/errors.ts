export class InstallerError extends Error {
  readonly statusCode: number
  readonly statusMessage: string

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'InstallerError'
    this.statusCode = statusCode
    this.statusMessage = message
  }
}

export function installerError(statusCode: number, message: string): never {
  throw new InstallerError(statusCode, message)
}

/** Nuxt-compatible shape kept internal so the shared engine has no framework dependency. */
export function createError(input: { statusCode: number, statusMessage: string }): InstallerError {
  return new InstallerError(input.statusCode, input.statusMessage)
}

export function installerErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { statusMessage?: unknown, message?: unknown }
    if (typeof value.statusMessage === 'string') return value.statusMessage
    if (typeof value.message === 'string') return value.message
  }
  return 'Cloudflare deployment failed'
}

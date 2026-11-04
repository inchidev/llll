import type { AuthCredentialProvider } from '../../shared/types'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'

export type EncryptedAuthSecret = EncryptedSecret

export async function encryptAuthSecret(authSecret: string, provider: AuthCredentialProvider, value: string): Promise<EncryptedAuthSecret> {
  return encryptSecret(authSecret, provider, value)
}

export async function decryptAuthSecret(authSecret: string, provider: AuthCredentialProvider, value: EncryptedAuthSecret): Promise<string> {
  return decryptSecret(authSecret, provider, value)
}

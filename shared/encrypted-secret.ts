const VERSION = 1
const encoder = new TextEncoder()

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

function base64UrlToBuffer(value: string): ArrayBuffer {
  const bytes = base64UrlToBytes(value)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function encryptionKey(installationSecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(installationSecret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: encoder.encode('llll-auth-secrets-v1'),
    info: encoder.encode('provider-credentials'),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export type EncryptedSecret = {
  ciphertext: string
  iv: string
  version: number
}

export async function encryptSecret(installationSecret: string, scope: string, value: string): Promise<EncryptedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: encoder.encode(`llll:${scope}:${VERSION}`),
  }, await encryptionKey(installationSecret), encoder.encode(value))
  return {
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    iv: bytesToBase64Url(iv),
    version: VERSION,
  }
}

export async function decryptSecret(installationSecret: string, scope: string, value: EncryptedSecret): Promise<string> {
  if (value.version !== VERSION) throw new Error(`Unsupported encrypted secret version: ${value.version}`)
  const decrypted = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: base64UrlToBuffer(value.iv),
    additionalData: encoder.encode(`llll:${scope}:${value.version}`),
  }, await encryptionKey(installationSecret), base64UrlToBuffer(value.ciphertext))
  return new TextDecoder().decode(decrypted)
}

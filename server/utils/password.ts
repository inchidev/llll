import { scryptAsync } from '@noble/hashes/scrypt.js'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js'

const N = 16384
const R = 8
const P = 1
const DK = 32

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, { N, r: R, p: P, dkLen: DK })
  return `scrypt$${N}$${R}$${P}$${bytesToHex(salt)}$${bytesToHex(key)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = hexToBytes(parts[4] ?? '')
  const want = parts[5] ?? ''
  const key = await scryptAsync(password, salt, { N: n, r, p, dkLen: want.length / 2 })
  return bytesToHex(key) === want
}

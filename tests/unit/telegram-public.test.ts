import { it, expect } from 'vitest'
import { verifyTelegramPublicData } from '../../shared/telegram'

it('verifies third-party Telegram login without a bot secret and rejects expired or altered claims', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex')
  const now = Date.now()
  const params = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: 123, first_name: 'Member' }), hash: 'ignored-by-public-verification' })
  const content = '456:WebAppData\n' + [...params].filter(([key]) => key !== 'hash').sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n')
  params.set('signature', Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(content))).toString('base64url'))
  expect((await verifyTelegramPublicData(params.toString(), '456', now, publicKey)).id).toBe(123)
  await expect(verifyTelegramPublicData(params.toString(), '789', now, publicKey)).rejects.toThrow()
  await expect(verifyTelegramPublicData(params.toString(), '456', now + 301000, publicKey)).rejects.toThrow()
  params.set('user', JSON.stringify({ id: 999, first_name: 'Impostor' }))
  await expect(verifyTelegramPublicData(params.toString(), '456', now, publicKey)).rejects.toThrow()
})

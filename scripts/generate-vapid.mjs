const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
)
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
if (!privateJwk.d) throw new Error('Could not export VAPID private key')

console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${privateJwk.d}`)
console.log('VAPID_SUBJECT=mailto:admin@example.com')

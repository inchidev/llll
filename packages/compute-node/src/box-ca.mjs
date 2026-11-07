import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

/**
 * A certificate authority of one box, and the certificates it issues for hosts with a bound Project secret.
 *
 * The daemon makes a fresh authority each time it starts a box and installs only its certificate in the box.
 * Its key exists in the daemon's and the box proxy's memory, never on a disk. The proxy issues a certificate
 * for a host the first time it terminates TLS for it. Plain DER, P-256 and SHA-256, with the extensions
 * OpenSSL's strict checks, GnuTLS and Node require.
 */
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)))
  const length = body.length < 0x80 ? Buffer.from([body.length]) : (() => { const bytes = []; for (let n = body.length; n; n >>= 8) bytes.unshift(n & 0xff); return Buffer.from([0x80 | bytes.length, ...bytes]) })()
  return Buffer.concat([Buffer.from([tag]), length, body])
}
const sequence = (...parts) => tlv(0x30, ...parts)
const set = (...parts) => tlv(0x31, ...parts)
const integer = bytes => tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes)
const oid = dotted => {
  const [first, second, ...rest] = dotted.split('.').map(Number)
  const bytes = [first * 40 + second]
  for (const value of rest) { const chunk = []; let n = value; do { chunk.unshift(n & 0x7f); n = Math.floor(n / 128) } while (n); bytes.push(...chunk.map((byte, index) => index < chunk.length - 1 ? byte | 0x80 : byte)) }
  return tlv(0x06, Buffer.from(bytes))
}
const utf8 = value => tlv(0x0c, Buffer.from(value, 'utf8'))
const octets = bytes => tlv(0x04, bytes)
const bits = bytes => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]))
const boolean = value => tlv(0x01, Buffer.from([value ? 0xff : 0]))
const explicit = (number, ...parts) => tlv(0xa0 | number, ...parts)
const time = date => {
  const iso = date.toISOString().replace(/[-:T]/gu, '').slice(0, 14) + 'Z'
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso))
}
const name = common => sequence(set(sequence(oid('2.5.4.3'), utf8(common))))
const extension = (id, critical, value) => sequence(oid(id), ...(critical ? [boolean(true)] : []), octets(value))
const ECDSA_SHA256 = sequence(oid('1.2.840.10045.4.3.2'))
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/gu).join('\n')}\n-----END ${label}-----\n`
const keyId = spki => createHash('sha1').update(spki).digest()

function certificate({ subject, issuer, spki, issuerSpki, signingKey, days, extensions }) {
  const now = Date.now()
  const tbs = sequence(explicit(0, integer(Buffer.from([2]))), integer(Buffer.concat([Buffer.from([0x40 | (randomBytes(1)[0] & 0x3f)]), randomBytes(15)])), ECDSA_SHA256,
    name(issuer), sequence(time(new Date(now - 3600000)), time(new Date(now + days * 86400000))), name(subject), spki,
    explicit(3, sequence(extension('2.5.29.14', false, octets(keyId(spki))), extension('2.5.29.35', false, sequence(tlv(0x80, keyId(issuerSpki)))), ...extensions)))
  return pem('CERTIFICATE', sequence(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, signingKey))))
}
const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }) }
}

/** A new authority for one box: valid for 90 days, a box restarts long before. */
export function createBoxCa(boxId) {
  const { privateKey, spki } = keyPair()
  const subject = `L4 box ${boxId}`
  const cert = certificate({ subject, issuer: subject, spki, issuerSpki: spki, signingKey: privateKey, days: 90, extensions: [
    extension('2.5.29.19', true, sequence(boolean(true), integer(Buffer.from([0])))),
    // keyCertSign and cRLSign.
    extension('2.5.29.15', true, tlv(0x03, Buffer.from([1, 0x06]))),
  ] })
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), subject }
}

/** A server certificate for one host, signed by the box's authority. */
export function issueHostCertificate(ca, host) {
  if (!/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/u.test(host)) throw new Error('Invalid host')
  const signingKey = createPrivateKey(ca.key)
  const issuerSpki = createPublicKey(signingKey).export({ type: 'spki', format: 'der' })
  const { privateKey, spki } = keyPair()
  const cert = certificate({ subject: host, issuer: ca.subject, spki, issuerSpki, signingKey, days: 7, extensions: [
    extension('2.5.29.19', true, sequence()),
    // digitalSignature.
    extension('2.5.29.15', true, tlv(0x03, Buffer.from([7, 0x80]))),
    extension('2.5.29.37', false, sequence(oid('1.3.6.1.5.5.7.3.1'))),
    extension('2.5.29.17', false, sequence(tlv(0x82, Buffer.from(host)))),
  ] })
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

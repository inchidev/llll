import { expect, it } from 'vitest'
import { mailAuthVerdict, trustedAuthResults } from '../../shared/mail-auth'

it('reads the results from the header Email Routing wrote', () => {
  expect(trustedAuthResults('mx.cloudflare.net; spf=pass smtp.mailfrom=a.example; dkim=pass header.d=a.example; dmarc=pass header.from=a.example'))
    .toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' })
  expect(trustedAuthResults('MX.Cloudflare.Net 1; DMARC=FAIL')).toEqual({ dmarc: 'fail' })
})

it('counts one good signature, and one DMARC failure', () => {
  expect(trustedAuthResults('mx.cloudflare.net; dkim=fail; dkim=pass')?.dkim).toBe('pass')
  expect(trustedAuthResults('mx.cloudflare.net; dmarc=pass; dmarc=fail')?.dmarc).toBe('fail')
})

it.each([
  ['a first header from anyone else', 'evil.example; dmarc=pass, mx.cloudflare.net; dmarc=pass'],
  ['a lookalike identifier', 'mx.cloudflare.net.evil.example; dmarc=pass'],
  ['nothing', null],
])('trusts nothing from %s', (_label, value) => {
  expect(trustedAuthResults(value)).toBeNull()
})

it('ignores what the sender can write after or inside the trusted header', () => {
  // A later header, joined by Headers.get, cannot add to or override the first.
  expect(trustedAuthResults('mx.cloudflare.net; dmarc=fail, mx.cloudflare.net; dmarc=pass')).toEqual({ dmarc: 'fail' })
  expect(trustedAuthResults('mx.cloudflare.net; spf=none, x; dmarc=pass')).toEqual({ spf: 'none' })
  expect(trustedAuthResults('mx.cloudflare.net; spf=fail smtp.mailfrom="a;dmarc=pass"')).toEqual({ spf: 'fail' })
  expect(trustedAuthResults('mx.cloudflare.net; spf=fail (a; dmarc=pass) smtp.mailfrom=a')).toEqual({ spf: 'fail' })
})

it('verifies only a pass with no DMARC failure', () => {
  expect(mailAuthVerdict({ dmarc: 'pass' })).toBe('verified')
  expect(mailAuthVerdict({ dmarc: 'none', spf: 'pass' })).toBe('verified')
  expect(mailAuthVerdict({ dmarc: 'fail', spf: 'pass', dkim: 'pass' })).toBe('failed')
  expect(mailAuthVerdict({ dmarc: 'none', spf: 'fail' })).toBe('unverified')
  expect(mailAuthVerdict({})).toBe('unverified')
  expect(mailAuthVerdict(null)).toBe('unverified')
})

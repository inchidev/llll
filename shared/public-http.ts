const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.internal',
])

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.localdomain']

function isIpv4(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)
}

function parseIpv4(host: string): number | null {
  if (!isIpv4(host)) return null
  const parts = host.split('.').map(part => Number(part))
  if (parts.some(part => part > 255)) return null
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

const PRIVATE_IPV4: Array<[number, number]> = [
  [0x00000000, 0xff000000], // 0.0.0.0/8
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0x64400000, 0xffc00000], // 100.64.0.0/10
  [0x7f000000, 0xff000000], // 127.0.0.0/8
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0000000, 0xffffff00], // 192.0.0.0/24
  [0xc0000200, 0xffffff00], // 192.0.2.0/24
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xc6120000, 0xfffe0000], // 198.18.0.0/15
  [0xc6336400, 0xffffff00], // 198.51.100.0/24
  [0xcb007100, 0xffffff00], // 203.0.113.0/24
  [0xe0000000, 0xe0000000], // 224.0.0.0/3: multicast, reserved, broadcast
]

function isPrivateIpv4(host: string): boolean {
  const ip = parseIpv4(host)
  if (ip === null) return true
  return PRIVATE_IPV4.some(([net, mask]) => ((ip & mask) >>> 0) === net)
}

function parseIpv6(host: string): number[] | null {
  let value = host.toLowerCase().replace(/%.*$/, '')
  const dotted = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const ip = parseIpv4(dotted[2]!)
    if (ip === null) return null
    value = `${dotted[1]}${(ip >>> 16).toString(16)}:${(ip & 0xffff).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.map(group => Number.parseInt(group, 16))
}

/** Allows only global unicast 2000::/3, minus ranges that tunnel to or embed IPv4 or are reserved. */
function isPrivateIpv6(host: string): boolean {
  const groups = parseIpv6(host)
  if (!groups) return true
  const [first, second] = groups as [number, number]
  if ((first & 0xe000) !== 0x2000) return true
  if (first === 0x2002) return true // 6to4
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return true // IETF special-purpose incl. Teredo; documentation
  return false
}

/** DNS answers must contain an address, never another hostname. */
export function isPublicIpAddress(address: string): boolean {
  return address.includes(':') ? !isPrivateIpv6(address) : isIpv4(address) && !isPrivateIpv4(address)
}

/** Rejects non-public, credentialed, or server-origin URLs before outbound requests. */
export function assertPublicHttpUrl(raw: string, serverHosts: string[] = []): URL {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Enter a URL')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  }
  catch {
    throw new Error('Enter a valid http or https URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed')
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with credentials are not allowed')
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!host) throw new Error('Enter a valid http or https URL')
  if (serverHosts.some(serverHost => host === serverHost.toLowerCase().replace(/\.+$/, ''))) {
    throw new Error('That address belongs to the server origin')
  }
  const isPrivate = host.includes(':')
    ? isPrivateIpv6(host)
    : isIpv4(host)
      ? isPrivateIpv4(host)
      : BLOCKED_HOSTS.has(host) || !host.includes('.') || BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))
  if (isPrivate) throw new Error('That address is not a public website')
  return parsed
}

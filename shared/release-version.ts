export function parseReleaseVersion(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value.replace(/^v/, ''))
  if (!match || match[4]?.split('.').some(part => /^0\d+$/.test(part))) throw new Error('Invalid release version')
  const numbers = match.slice(1, 4).map(Number)
  if (!numbers.every(Number.isSafeInteger)) throw new Error('Release version is too large')
  return { numbers, pre: match[4]?.split('.') || [] }
}
export function compareVersions(left: string, right: string) {
  const a = parseReleaseVersion(left), b = parseReleaseVersion(right)
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i]! - b.numbers[i]!)
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const leftPart = a.pre[i], rightPart = b.pre[i]
    if (leftPart === rightPart) continue
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const an = /^\d+$/.test(leftPart), bn = /^\d+$/.test(rightPart)
    if (an && bn) return leftPart.length === rightPart.length ? (leftPart < rightPart ? -1 : 1) : Math.sign(leftPart.length - rightPart.length)
    if (an !== bn) return an ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value || '')
  if (!match || match[4]?.split('.').some(part => /^0\d+$/.test(part))) throw new Error('Use a semantic version without build metadata')
  if (match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part)))) throw new Error('Version number is too large')
  return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') || [] }
}

export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right)
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i])
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === b.pre[i]) continue
    if (a.pre[i] === undefined) return -1
    if (b.pre[i] === undefined) return 1
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i])
    if (an && bn) return a.pre[i].length === b.pre[i].length ? (a.pre[i] < b.pre[i] ? -1 : 1) : Math.sign(a.pre[i].length - b.pre[i].length)
    if (an !== bn) return an ? -1 : 1
    return a.pre[i] < b.pre[i] ? -1 : 1
  }
  return 0
}

export function releasePlan({ previous, version, libraryVersion, releasePr, notesExist }) {
  parseVersion(version)
  if (libraryVersion !== version) throw new Error('Root and deployment library must share the L4 version')
  if (version === previous) {
    if (releasePr) throw new Error('A release PR must change version')
    return { release: false, version }
  }
  if (!releasePr) throw new Error('Only a PR labelled release may change version')
  if (compareVersions(version, previous) <= 0) throw new Error('A release must increase version')
  if (!notesExist) throw new Error('The release PR must include versioned release notes')
  return { release: true, version, tag: `v${version}` }
}

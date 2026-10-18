export function pullRequestCandidate(output, branch, commit) {
  const refs = new Map(output.trim().split('\n').map(line => { const [sha, ref] = line.trim().split(/\s+/); return [ref, sha] }))
  const main = refs.get('refs/heads/main')
  if (!main || refs.get(`refs/heads/${branch}`) !== commit) return null
  for (const [sha, ref] of output.trim().split('\n').map(line => line.trim().split(/\s+/))) {
    const match = ref?.match(/^refs\/pull\/(\d+)\/head$/)
    if (sha === commit && match && refs.has(`refs/pull/${match[1]}/merge`)) return { number: Number(match[1]), main, head: commit }
  }
  return null
}

export function verifyMergeParents(commitObject, candidate) {
  const header = commitObject.split('\n\n')[0]
  const parents = [...header.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1])
  return parents.length === 2 && parents[0] === candidate.main && parents[1] === candidate.head
}

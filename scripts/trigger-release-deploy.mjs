const hook = process.env.RELEASE_HOOK
if (process.env.GITHUB_ACTIONS !== 'true' || !hook || !process.env.RELEASE_COMMIT || !process.env.RELEASE_VERSION) throw new Error('Only the release workflow may trigger production')
async function startBuild() {
  const response = await fetch(hook, { method: 'POST', signal: AbortSignal.timeout(20000) }).catch(() => { throw new Error('Cloudflare release hook request failed') })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.success) throw new Error('Cloudflare release Build could not be started')
  return data.result?.already_exists === true
}
let reusedBuild = await startBuild()
for (let attempt = 0; attempt < 120; attempt++) {
  const response = await fetch('https://llll.gg/api/health', { signal: AbortSignal.timeout(10000) }).catch(() => null)
  const health = response?.ok ? await response.json() : null
  if (health?.commit === process.env.RELEASE_COMMIT && health?.version === process.env.RELEASE_VERSION) {
    console.log(`Production verified: v${process.env.RELEASE_VERSION} (${health.commit})`)
    process.exit(0)
  }
  // A main Build already in flight may have resolved releases before publication.
  // If the hook reused it, request a fresh Build after it leaves the queue.
  if (reusedBuild && attempt % 6 === 5) reusedBuild = await startBuild()
  await new Promise(resolve => setTimeout(resolve, 10000))
}
throw new Error('Released production version did not become healthy; retry this exact release PR workflow without replacing its tag or assets')

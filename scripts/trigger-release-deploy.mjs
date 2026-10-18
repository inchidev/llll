const hook = process.env.RELEASE_HOOK
if (process.env.GITHUB_ACTIONS !== 'true' || !hook || !process.env.RELEASE_COMMIT || !process.env.RELEASE_VERSION) throw new Error('Only the release workflow may trigger production')
const response = await fetch(hook, { method: 'POST', signal: AbortSignal.timeout(20000) }).catch(() => { throw new Error('Cloudflare release hook request failed') })
if (!response.ok || !(await response.json()).success) throw new Error('Cloudflare release Build could not be started')
for (let attempt = 0; attempt < 120; attempt++) {
  const response = await fetch('https://llll.gg/api/health', { signal: AbortSignal.timeout(10000) }).catch(() => null)
  const health = response?.ok ? await response.json() : null
  if (health?.commit === process.env.RELEASE_COMMIT && health?.version === process.env.RELEASE_VERSION) {
    console.log(`Production verified: v${process.env.RELEASE_VERSION} (${health.commit})`)
    process.exit(0)
  }
  await new Promise(resolve => setTimeout(resolve, 10000))
}
throw new Error('Released production version did not become healthy; retry this exact release PR workflow without replacing its tag or assets')

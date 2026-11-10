import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkoutCheckpoint, settleCheckout, writeCheckpoint } from './cloud-io.mjs'
import { copyCommit, git, hardenedEnv } from './review-diff.mjs'

/**
 * The trusted daemon's checkpoint of an L4 Compute box, in the format a Cloudflare box uses (cloud-io.mjs), so an
 * idle box can give its machine back and a new machine restores it. Three steps, each in a throwaway container of
 * its own, none of them the box:
 *
 * - `save`, with no network, the stopped box's disk at /work and a scratch disk at /mirror: writes the checkpoint
 *   commit in the box's checkout and copies it, with its history, into a bare repository on the scratch disk.
 * - `push`, with the network and the scratch disk only: pushes that commit to `l4-state` through the Server, with
 *   the Server's capability for this box and lease. The box's disk is not there, so nothing of the box runs here.
 * - `restore`, with no network, a new box's disk at /work and the fetched checkpoint as a bundle: the checkout comes
 *   back as it was.
 *
 * Git here never trusts the box's repository (review-diff.mjs): no system or global config, hooks or fsmonitor.
 */
const SHA = /^[a-f0-9]{40}$/u
const run = async (cwd, args, extra = {}) => (await git(cwd, args, { env: { ...hardenedEnv(), ...extra }, timeoutMs: 300000 })).text.trim()
const exists = (root, sha) => git(root, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false)

export async function saveCheckpoint({ root = '/work/repo', mirror = '/mirror/repo.git', baseSha, previous = null }) {
  if (!SHA.test(baseSha) || (previous !== null && !SHA.test(previous))) throw new Error('Invalid checkpoint request')
  // The previous checkpoint is a parent when the checkout still has it; one the Agent's own Git pruned is left out.
  const made = await writeCheckpoint(run, root, { baseSha, previous: previous && await exists(root, previous) ? previous : undefined })
  const copied = await copyCommit({ box: root, mirror, sha: made.checkpoint, baseSha })
  if (!copied.ok) throw new Error('The checkpoint could not be copied')
  return { ok: true, checkpoint: made.checkpoint, head: made.head }
}

export async function pushCheckpoint({ mirror = '/mirror/repo.git', remote, authorization, sha }) {
  const url = new URL(remote)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/api\/compute-agent\/checkpoint\/[a-f0-9-]{36}\.git$/u.test(url.pathname)
    || !/^Bearer [a-f0-9]{64}$/u.test(authorization ?? '') || !SHA.test(sha)) throw new Error('Invalid checkpoint push')
  const env = hardenedEnv([['protocol.allow', 'never'], ['protocol.https.allow', 'always'], [`http.${url.origin}/.extraheader`, `AUTHORIZATION: ${authorization}`],
    ['http.followRedirects', 'false'], ['http.lowSpeedLimit', '1024'], ['http.lowSpeedTime', '30']])
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'GIT_SSL_CAINFO']) if (process.env[key]) env[key] = process.env[key]
  // The box's own repository: the Server lets only `l4-state` move, and the checkpoint counts once it reads it back.
  await git(mirror, ['push', '--quiet', '--no-verify', '--porcelain', '--force', remote, `${sha}:refs/heads/l4-state`], { env, timeoutMs: 600000 })
  return { ok: true }
}

export async function restoreCheckpoint({ work = '/work', bundle = '/bootstrap/source.bundle', checkpoint, baseSha }) {
  if (!SHA.test(checkpoint) || !SHA.test(baseSha)) throw new Error('Invalid restore request')
  const root = `${work}/repo`
  await mkdir(work, { recursive: true })
  await rm(root, { recursive: true, force: true })
  await run(work, ['clone', '--no-checkout', '--quiet', bundle, 'repo'])
  if (await run(root, ['rev-parse', 'refs/remotes/origin/source']) !== checkpoint) throw new Error('Checkpoint differs from the acknowledged state')
  await checkoutCheckpoint(run, root, checkpoint)
  await settleCheckout(run, root, baseSha)
  return { ok: true }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const chunks = []; let size = 0
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 10000) throw new Error('Request limit'); chunks.push(chunk) }
    const { operation, baseSha, previous, remote, authorization, sha, checkpoint } = JSON.parse(Buffer.concat(chunks).toString())
    const result = operation === 'save' ? await saveCheckpoint({ baseSha, previous: previous ?? null })
      : operation === 'push' ? await pushCheckpoint({ remote, authorization, sha })
        : operation === 'restore' ? await restoreCheckpoint({ checkpoint, baseSha }) : null
    if (!result) throw new Error('Invalid checkpoint operation')
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    // Git's words could quote the push's capability: only that it failed is reported.
    process.stdout.write(JSON.stringify({ ok: false }) + '\n')
    process.exitCode = 1
  }
}

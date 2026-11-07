import { rm } from 'node:fs/promises'
import { git } from './files.mjs'

/**
 * A box's first start: the trusted daemon fetched the Task's pinned source into a bundle, and this
 * throwaway container, with no network, clones it into the Task disk at /work/repo. The box works on
 * branch `work` from the pinned base; the bundle's remote goes, so nothing points back at the host.
 */
try {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 10000) throw new Error('Checkout request limit'); chunks.push(chunk) }
  const { baseSha } = JSON.parse(Buffer.concat(chunks).toString())
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) throw new Error('Invalid base')
  const root = process.env.LLLL_BOX_ROOT || '/work', repository = `${root}/repo`
  await rm(repository, { recursive: true, force: true })
  await git(root, 'clone', '--no-checkout', '--quiet', '/bootstrap/source.bundle', 'repo')
  await git(repository, 'checkout', '--quiet', '-b', 'work', baseSha)
  await git(repository, 'remote', 'remove', 'origin')
  await git(repository, 'config', 'user.name', 'L4 Agent')
  await git(repository, 'config', 'user.email', 'agent@local.invalid')
  process.stdout.write(JSON.stringify({ ok: true }))
} catch {
  process.stdout.write(JSON.stringify({ ok: false }))
  process.exitCode = 1
}

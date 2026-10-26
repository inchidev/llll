// Fixed image helper. No provider token ever enters the container.
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { runProcess } from './process.mjs'

const root = '/workspace/repo'
const env = { HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_SSL_CAINFO: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' }
const git = async (cwd, args, extra = {}) => {
  const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', ...args], { cwd, env: { ...env, ...extra }, limit: 100000, timeoutMs: 120000 })
  if (result.code !== 0) throw new Error('Code storage operation failed; check source access, checkpoint capacity and recovery state')
  return result.stdout.toString().trim()
}
export async function codeState(input) {
  if (!/^[a-f0-9]{40}$/u.test(input.baseSha) || !/^https:\/\//u.test(input.remote)) throw new Error('Invalid code storage identity')
  if (input.operation === 'bootstrap' || input.operation === 'restore') {
    await mkdir('/workspace', { recursive: true })
    await git('/workspace', ['clone', '--no-checkout', input.remote, 'repo'])
    if (input.operation === 'bootstrap') await git(root, ['checkout', '-b', 'work', input.baseSha])
    else {
      if (!/^[a-f0-9]{40}$/u.test(input.checkpoint)) throw new Error('Missing acknowledged checkpoint')
      const state = await git(root, ['rev-parse', 'refs/remotes/origin/l4-state'])
      if (state !== input.checkpoint) throw new Error('Checkpoint differs from the acknowledged state; inspect recovery')
      const parents = (await git(root, ['show', '-s', '--format=%P', state])).split(' ')
      if (parents.length < 2 || parents.length > 3) throw new Error('Invalid code checkpoint')
      await git(root, ['checkout', '-b', 'work', parents[0]])
      await git(root, ['read-tree', '--reset', '-u', state])
      await git(root, ['read-tree', parents[1]])
    }
    await git(root, ['merge-base', '--is-ancestor', input.baseSha, 'HEAD'])
    await git(root, ['remote', 'remove', 'origin'])
    await git(root, ['config', 'user.name', 'L4 Agent'])
    await git(root, ['config', 'user.email', 'agent@local.invalid'])
    await git(root, ['config', 'core.hooksPath', '/dev/null'])
    return { ok: true }
  }
  if (input.operation !== 'checkpoint') throw new Error('Invalid code storage operation')
  await git(root, ['merge-base', '--is-ancestor', input.baseSha, 'HEAD'])
  const head = await git(root, ['rev-parse', 'HEAD'])
  const index = await git(root, ['write-tree'])
  const identity = { GIT_AUTHOR_NAME: 'L4 private checkpoint', GIT_AUTHOR_EMAIL: 'checkpoint@local.invalid', GIT_COMMITTER_NAME: 'L4 private checkpoint', GIT_COMMITTER_EMAIL: 'checkpoint@local.invalid' }
  const staged = await git(root, ['commit-tree', index, '-p', head, '-m', 'Private index checkpoint'], identity)
  const temporaryIndex = '/tmp/l4-checkpoint-index'
  await unlink(temporaryIndex).catch(error => { if (error.code !== 'ENOENT') throw error })
  const temporaryEnv = { ...identity, GIT_INDEX_FILE: temporaryIndex }
  await git(root, ['read-tree', head], temporaryEnv)
  // Explicitly disposable caches. Tracked source remains in history and checkpoints.
  await writeFile('/tmp/l4-checkpoint-ignore', 'node_modules/\n.nuxt/\n.output/\ndist/\nbuild/\n.cache/\n')
  await git(root, ['-c', 'core.excludesFile=/tmp/l4-checkpoint-ignore', 'add', '-A'], temporaryEnv)
  const tree = await git(root, ['write-tree'], temporaryEnv)
  const checkpoint = await git(root, ['commit-tree', tree, '-p', head, '-p', staged, ...(input.checkpoint ? ['-p', input.checkpoint] : []), '-m', 'Private working files checkpoint'], identity)
  const count = await git(root, ['count-objects', '-v'])
  const sizes = Object.fromEntries(count.split('\n').map(line => line.split(': ')))
  if (1024 * (Number(sizes.size) + Number(sizes['size-pack'])) > 500000000) throw new Error('Code history exceeds the configured 500 MB checkpoint budget; export source before continuing')
  await git(root, ['push', `--force-with-lease=refs/heads/l4-state:${input.checkpoint ?? ''}`, input.remote, `${checkpoint}:refs/heads/l4-state`])
  await unlink(temporaryIndex)
  return { ok: true, checkpoint, head, tree }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const input = await readFile('/dev/stdin', 'utf8')
    if (Buffer.byteLength(input) > 8000) throw new Error('Invalid storage request')
    process.stdout.write(JSON.stringify(await codeState(JSON.parse(input))))
  } catch { process.stdout.write(JSON.stringify({ ok: false, message: 'Code checkpoint or restoration failed. The last acknowledged code is retained; inspect storage capacity and recovery before continuing.' })) }
}

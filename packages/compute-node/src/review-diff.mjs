import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * The trusted daemon's look at a commit the Agent asked to publish. It runs in a throwaway container with no
 * network, the box's disk mounted read-only at /box and a fresh scratch disk at /mirror. Git here never trusts
 * the box's repository: no system or global config, hooks, fsmonitor, replace objects, external diff or
 * textconv; the command line's config outranks the repository's own, and every fetched object is checked.
 *
 * It copies exactly the requested commit, with its history, into a bare repository on the scratch disk,
 * checks that it descends from the Task's pinned base and, for a review, writes the commits and diff from
 * the base. A push then goes from that copy, never from the box.
 *
 * On Cloudflare there is no second disk: the copy is a bare repository of its own in the container's /tmp
 * that reads the checkout's objects as an alternate, so neither the box's config nor its refs count.
 */
export const REVIEW_PATCH_CHARS = 2_000_000, REVIEW_STAT_CHARS = 64_000
const SHA = /^[a-f0-9]{40}$/u
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
/** Settings every Git process here runs with, the box's upload-pack included: they outrank its repository config. */
export const HARDENED_GIT = [
  ['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['core.attributesFile', '/dev/null'], ['core.sshCommand', '/bin/false'],
  ['protocol.allow', 'never'], ['protocol.file.allow', 'always'], ['uploadpack.allowAnySHA1InWant', 'true'],
  ['transfer.fsckObjects', 'true'], ['fetch.fsckObjects', 'true'], ['safe.directory', '*'], ['gc.auto', '0'],
]
export function hardenedEnv(extra = []) {
  const entries = [...HARDENED_GIT, ...extra]
  return { PATH, HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_COUNT: String(entries.length), ...Object.fromEntries(entries.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])) }
}

/**
 * One Git command; output past `limit` characters is cut off and reported, never read further. A failure
 * carries the end of what Git said, on `stdout` and `stderr`, for a caller to report what went wrong.
 */
export function git(cwd, args, { limit = 100000, timeoutMs = 120000, env = hardenedEnv() } = {}) {
  return new Promise((done, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let text = '', truncated = false, stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (truncated) return
      text += chunk
      if (text.length > limit) { text = text.slice(0, limit); truncated = true; child.kill('SIGKILL') }
    })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0 && !truncated) reject(Object.assign(new Error(`git ${args[0]} failed`), { stdout: text.slice(-4000), stderr })); else done({ text, truncated })
    })
  })
}

export async function copyCommit({ box = '/box/repo', mirror = '/mirror/repo.git', sha, baseSha, review = false, shared = false }) {
  if (!SHA.test(sha) || !SHA.test(baseSha)) throw new Error('Invalid commit')
  await git(resolve(mirror, '..'), ['init', '--quiet', '--bare', mirror])
  if (shared) {
    await writeFile(join(mirror, 'objects/info/alternates'), join(box, '.git/objects') + '\n', { mode: 0o600 })
    await git(mirror, ['update-ref', 'refs/heads/approved', sha])
  }
  // The commit and its history only: no tags, refs or FETCH_HEAD from the box.
  else await git(mirror, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', `file://${box}`, `${sha}:refs/heads/approved`], { timeoutMs: 300000 })
  if ((await git(mirror, ['rev-parse', '--verify', 'refs/heads/approved^{commit}'])).text.trim() !== sha) throw new Error('The copied commit differs')
  try { await git(mirror, ['merge-base', '--is-ancestor', baseSha, sha]) } catch { throw new Error('The commit does not descend from the Task’s pinned base') }
  if (!review) return { ok: true, sha }
  const range = [baseSha, sha], plain = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames']
  const log = await git(mirror, ['log', '--no-color', '--max-count=200', '--format=%H%x09%s', `${baseSha}..${sha}`])
  const commits = log.text.split('\n').filter(Boolean).map(line => ({ sha: line.slice(0, 40), subject: line.slice(41, 541) })).filter(commit => SHA.test(commit.sha))
  const stat = await git(mirror, ['diff', ...plain, '--stat=200', ...range], { limit: REVIEW_STAT_CHARS })
  const patch = await git(mirror, ['diff', ...plain, ...range], { limit: REVIEW_PATCH_CHARS, timeoutMs: 300000 })
  return { ok: true, review: { sha, baseSha, commits, stat: stat.text, patch: patch.text, truncated: patch.truncated || stat.truncated || commits.length >= 200 } }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const chunks = []; let size = 0
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 10000) throw new Error('Request limit'); chunks.push(chunk) }
    const { sha, baseSha, review } = JSON.parse(Buffer.concat(chunks).toString())
    process.stdout.write(JSON.stringify(await copyCommit({ sha, baseSha, review: review === true })) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, message: error instanceof Error ? error.message.slice(0, 300) : 'Review failed' }) + '\n')
    process.exitCode = 1
  }
}

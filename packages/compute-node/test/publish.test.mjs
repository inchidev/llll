import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyCommit } from '../src/review-diff.mjs'
import { pushBranch, pushFailure, pushRef } from '../src/push-branch.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
async function boxRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'l4-publish-')), box = join(directory, 'repo')
  await mkdir(box)
  git(box, 'init', '-q', '-b', 'work'); git(box, 'config', 'user.name', 'L4 Agent'); git(box, 'config', 'user.email', 'agent@local.invalid')
  await writeFile(join(box, 'answer.txt'), 'wrong\n'); git(box, 'add', '.'); git(box, 'commit', '-qm', 'Pinned base')
  const baseSha = git(box, 'rev-parse', 'HEAD')
  await writeFile(join(box, 'answer.txt'), 'right\n'); await writeFile(join(box, 'sprite.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]))
  git(box, 'add', '.'); git(box, 'commit', '-qm', 'Fix the answer')
  return { directory, box, baseSha, sha: git(box, 'rev-parse', 'HEAD') }
}

test('copies exactly the requested commit out of the box and reviews it from the copy, ignoring the box’s own Git config', async () => {
  const { directory, box, baseSha, sha } = await boxRepository()
  const proof = join(directory, 'box-config-ran')
  try {
    // What an Agent could leave in its checkout to run code in whoever reads it.
    git(box, 'config', 'core.fsmonitor', `touch ${proof}`)
    git(box, 'config', 'diff.external', `touch ${proof}`)
    git(box, 'config', 'uploadpack.packObjectsHook', `touch ${proof}`)
    await mkdir(join(box, '.githooks'), { recursive: true }); await writeFile(join(box, '.githooks/post-checkout'), `#!/bin/sh\ntouch ${proof}\n`, { mode: 0o755 })
    git(box, 'config', 'core.hooksPath', join(box, '.githooks'))
    await writeFile(join(box, '.gitattributes'), '*.txt diff=evil\n'); git(box, 'config', 'diff.evil.textconv', `touch ${proof};cat`)
    git(box, 'replace', sha, baseSha)
    await mkdir(join(directory, 'mirror'))
    const result = await copyCommit({ box, mirror: join(directory, 'mirror/repo.git'), sha, baseSha, review: true })
    assert.equal(result.ok, true)
    assert.deepEqual(result.review.commits, [{ sha, subject: 'Fix the answer' }])
    assert.match(result.review.patch, /-wrong\n\+right/u)
    assert.match(result.review.patch, /Binary files .*sprite\.png differ/u)
    assert.match(result.review.stat, /2 files changed/u)
    assert.equal(result.review.truncated, false)
    await assert.rejects(stat(proof), { code: 'ENOENT' })
    // The copy has the commit and its history, and none of the box's refs or replacements.
    const mirror = join(directory, 'mirror/repo.git')
    assert.equal(git(mirror, 'rev-parse', 'refs/heads/approved'), sha)
    assert.equal(git(mirror, 'for-each-ref', '--format=%(refname)'), 'refs/heads/approved')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('refuses a commit that is not there or does not descend from the pinned base', async () => {
  const { directory, box, baseSha, sha } = await boxRepository()
  try {
    git(box, 'checkout', '-q', '--orphan', 'other'); await writeFile(join(box, 'other.txt'), 'unrelated\n'); git(box, 'add', 'other.txt'); git(box, 'commit', '-qm', 'Unrelated history')
    const unrelated = git(box, 'rev-parse', 'HEAD')
    for (const [name, commit, base] of [['unrelated', unrelated, baseSha], ['missing', 'f'.repeat(40), baseSha], ['base after head', baseSha, sha]]) {
      const mirror = join(directory, name)
      await mkdir(mirror)
      await assert.rejects(copyCommit({ box, mirror: join(mirror, 'repo.git'), sha: commit, baseSha: base }), undefined, name)
    }
    await assert.rejects(copyCommit({ box, mirror: join(directory, 'x.git'), sha: 'HEAD', baseSha }), /Invalid commit/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a push names only a box’s own branch, one commit and a known remote with its credential', async () => {
  const ref = 'refs/heads/l4-agent/00000000-0000-4000-8000-0000000000c1', sha = 'c'.repeat(40), token = 'ghs_' + 'x'.repeat(36)
  const github = 'https://github.com/inchidev/afterprompt.git'
  for (const input of [
    { remote: github, ref: 'refs/heads/main', sha, expectedOld: null, token },
    { remote: github, ref: 'refs/tags/v1', sha, expectedOld: null, token },
    { remote: github, ref, sha: 'HEAD', expectedOld: null, token },
    { remote: github, ref, sha, expectedOld: 'main', token },
    { remote: github, ref, sha, expectedOld: null },
    { remote: 'https://attacker.example/inchidev/afterprompt.git', ref, sha, expectedOld: null, token },
    { remote: 'https://user:pass@github.com/inchidev/afterprompt.git', ref, sha, expectedOld: null, token },
    { remote: 'file:///tmp/repo.git', ref, sha, expectedOld: null, token },
    { remote: 'https://server.example/api/compute-agent/publish/00000000-0000-4000-8000-0000000000f1.git', ref, sha, expectedOld: null, authorization: 'Bearer short' },
  ]) await assert.rejects(pushBranch({ mirror: '/nonexistent', ...input }), /Invalid push/u, JSON.stringify(input))
})

test('a push goes to the box’s branch under the Project’s prefix, or with fastForward to a base branch', async () => {
  const box = '00000000-0000-4000-8000-0000000000c1'
  for (const ref of [`refs/heads/l4-agent/${box}`, `refs/heads/agents/${box}`, `refs/heads/team/ai-${box}`]) {
    assert.equal(pushRef(ref, { boxId: box }), true, ref)
    assert.equal(pushRef(ref), true, ref)
  }
  for (const ref of ['refs/heads/main', `refs/heads/${box}`, `refs/heads/agents/00000000-0000-4000-8000-0000000000c2`, `refs/tags/l4-agent/${box}`, `refs/heads/../${box}`, `refs/heads/a//${box}`])
    assert.equal(pushRef(ref, { boxId: box }), false, ref)
  for (const ref of ['refs/heads/main', 'refs/heads/release/2026', 'refs/heads/feature_x']) assert.equal(pushRef(ref, { fastForward: true }), true, ref)
  for (const ref of ['refs/tags/v1', 'refs/heads/', 'refs/heads/main.lock', 'refs/heads/.x', 'refs/heads/a..b', 'refs/heads/x/', 'refs/heads/a@{1}', 'HEAD', 'refs/heads/a b'])
    assert.equal(pushRef(ref, { fastForward: true }), false, ref)
  const github = 'https://github.com/inchidev/afterprompt.git', sha = 'c'.repeat(40), token = 'ghs_' + 'x'.repeat(36)
  // A fast-forward names the head it replaces.
  for (const expectedOld of [null, 'main', undefined]) await assert.rejects(pushBranch({ mirror: '/nonexistent', remote: github, ref: 'refs/heads/main', sha, expectedOld, fastForward: true, token }), /Invalid push/u)
  await assert.rejects(pushBranch({ mirror: '/nonexistent', remote: github, ref: 'refs/heads/main', sha, expectedOld: null, fastForward: 'yes', token }), /Invalid push/u)
})

test('a direct push goes ahead only when the approved commit descends from the branch’s head', async () => {
  const { directory, box, baseSha, sha } = await boxRepository()
  const previous = process.env.LLLL_PUSH_INSECURE_LOCAL
  process.env.LLLL_PUSH_INSECURE_LOCAL = '1'
  try {
    await mkdir(join(directory, 'mirror'))
    const mirror = join(directory, 'mirror/repo.git')
    await copyCommit({ box, mirror, sha, baseSha })
    // Nothing listens there: a fast-forward gets as far as Git's push, which fails to connect.
    const remote = 'http://127.0.0.1:9/inchidev/afterprompt.git', other = 'f'.repeat(40)
    await assert.rejects(pushBranch({ mirror, remote, ref: 'refs/heads/main', sha, expectedOld: other, fastForward: true }, { outbound: true }), /does not descend from: a direct push only fast-forwards/u)
    await assert.rejects(pushBranch({ mirror, remote, ref: 'refs/heads/main', sha: baseSha, expectedOld: sha, fastForward: true }, { outbound: true }), /does not descend/u)
    await assert.rejects(pushBranch({ mirror, remote, ref: 'refs/heads/main', sha, expectedOld: baseSha, fastForward: true }, { outbound: true }), error => !/does not descend|Invalid push/u.test(error.message))
  } finally {
    if (previous === undefined) delete process.env.LLLL_PUSH_INSECURE_LOCAL; else process.env.LLLL_PUSH_INSECURE_LOCAL = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed push says what Git said, never its credential', () => {
  const token = 'ghs_' + 'y'.repeat(36), basic = Buffer.from('x-access-token:' + token).toString('base64'), capability = 'd'.repeat(64)
  const reason = pushFailure({
    stdout: `To https://github.com/inchidev/afterprompt.git\n!\t${'c'.repeat(40)}:refs/heads/l4-agent/x\t[rejected] (stale info)\nDone\n`,
    stderr: `remote: token ${token} is not allowed\nerror: AUTHORIZATION: basic ${basic}\nfatal: unable to access 'https://x:${capability}@server.example/': 403\nhint: retry\n`,
  }, [token, basic, capability])
  assert.match(reason, /\[rejected\] \(stale info\)/u)
  assert.match(reason, /fatal: unable to access/u)
  for (const secret of [token, basic, capability, 'hint:', 'Done', 'To https']) assert.equal(reason.includes(secret), false, secret)
  assert.equal(pushFailure({ stderr: `Authorization: Bearer ${'e'.repeat(64)}` }, []).includes('e'.repeat(64)), false)
  assert.ok(pushFailure({ stderr: 'x'.repeat(1000) }, []).length <= 300)
})

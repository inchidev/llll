import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyCommit } from '../src/review-diff.mjs'
import { pushBranch } from '../src/push-branch.mjs'

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

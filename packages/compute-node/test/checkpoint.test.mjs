import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pushCheckpoint, restoreCheckpoint, saveCheckpoint } from '../src/checkpoint.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()

/** A box's disk as the Agent leaves it: commits on `work`, a staged change, an unstaged one, new files and a cache. */
async function boxDisk(directory) {
  const work = join(directory, 'work'), root = join(work, 'repo')
  await mkdir(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'work'); git(root, 'config', 'user.name', 'L4 Agent'); git(root, 'config', 'user.email', 'agent@local.invalid')
  await writeFile(join(root, 'answer.txt'), 'original\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Pinned base')
  const baseSha = git(root, 'rev-parse', 'HEAD')
  await writeFile(join(root, 'level.txt'), 'level one\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Add a level')
  await writeFile(join(root, 'answer.txt'), 'staged\n'); git(root, 'add', 'answer.txt')
  await writeFile(join(root, 'answer.txt'), 'unstaged\n')
  await mkdir(join(root, 'art'), { recursive: true })
  await writeFile(join(root, 'art', 'sprite.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]))
  await mkdir(join(root, 'node_modules'), { recursive: true }); await writeFile(join(root, 'node_modules', 'cache'), 'disposable')
  return { work, root, baseSha, head: git(root, 'rev-parse', 'HEAD') }
}
/** What the daemon's source fetch makes of the checkpoint the Server serves: a bundle with `source` at it. */
function bundleOf(directory, mirror, sha) {
  const bare = join(directory, `fetch-${sha.slice(0, 8)}.git`), bundle = join(directory, `${sha.slice(0, 8)}.bundle`)
  git(directory, 'init', '-q', '--bare', bare)
  git(bare, 'fetch', '-q', '--no-tags', mirror, sha)
  git(bare, 'update-ref', 'refs/heads/source', sha)
  git(bare, 'bundle', 'create', '-q', bundle, '--all')
  return bundle
}

test('an L4 Compute box is saved and restored in the Cloudflare checkpoint format: HEAD, index and working files come back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'l4-checkpoint-'))
  try {
    const box = await boxDisk(directory)
    await mkdir(join(directory, 'mirror'))
    const mirror = join(directory, 'mirror', 'repo.git')
    const first = await saveCheckpoint({ root: box.root, mirror, baseSha: box.baseSha })
    assert.equal(first.ok, true)
    assert.equal(first.head, box.head)
    // The checkpoint's parents: HEAD, then the index as a commit of its own.
    const parents = git(mirror, 'show', '-s', '--format=%P', first.checkpoint).split(' ')
    assert.equal(parents.length, 2)
    assert.equal(parents[0], box.head)
    assert.equal(git(mirror, 'show', `${parents[1]}:answer.txt`), 'staged')
    // Saving changes nothing the Agent sees.
    assert.equal(git(box.root, 'show', ':answer.txt'), 'staged')
    assert.equal(await readFile(join(box.root, 'answer.txt'), 'utf8'), 'unstaged\n')

    // A new machine: an empty disk, the fetched checkpoint.
    const fresh = join(directory, 'fresh')
    assert.deepEqual(await restoreCheckpoint({ work: fresh, bundle: bundleOf(directory, mirror, first.checkpoint), checkpoint: first.checkpoint, baseSha: box.baseSha }), { ok: true })
    const root = join(fresh, 'repo')
    assert.equal(git(root, 'rev-parse', 'HEAD'), box.head)
    assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'work')
    assert.equal(git(root, 'log', '-1', '--format=%s'), 'Add a level')
    assert.equal(git(root, 'show', ':answer.txt'), 'staged')
    assert.equal(await readFile(join(root, 'answer.txt'), 'utf8'), 'unstaged\n')
    assert.deepEqual(await readFile(join(root, 'art', 'sprite.png')), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]))
    await assert.rejects(stat(join(root, 'node_modules', 'cache')), { code: 'ENOENT' })
    assert.equal(git(root, 'remote'), '')
    assert.equal(git(root, 'config', 'core.hooksPath'), '/dev/null')

    // The next save there names the first as its third parent; one the checkout no longer has is left out.
    await writeFile(join(root, 'level.txt'), 'level two\n')
    await mkdir(join(directory, 'mirror2'))
    const second = await saveCheckpoint({ root, mirror: join(directory, 'mirror2', 'repo.git'), baseSha: box.baseSha, previous: first.checkpoint })
    assert.equal(git(root, 'show', '-s', '--format=%P', second.checkpoint).split(' ')[2], first.checkpoint)
    await mkdir(join(directory, 'mirror3'))
    const orphan = await saveCheckpoint({ root, mirror: join(directory, 'mirror3', 'repo.git'), baseSha: box.baseSha, previous: 'f'.repeat(40) })
    assert.equal(git(root, 'show', '-s', '--format=%P', orphan.checkpoint).split(' ').length, 2)

    // A bundle that is not at the acknowledged checkpoint is refused, and so is a commit that is not one.
    await assert.rejects(restoreCheckpoint({ work: join(directory, 'other'), bundle: bundleOf(directory, mirror, first.checkpoint), checkpoint: second.checkpoint, baseSha: box.baseSha }), /differs/u)
    await assert.rejects(restoreCheckpoint({ work: join(directory, 'plain'), bundle: bundleOf(directory, mirror, box.head), checkpoint: box.head, baseSha: box.baseSha }), /Invalid code checkpoint/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a checkpoint is pushed only to the Server’s checkpoint address with its capability', async () => {
  const sha = 'e'.repeat(40), authorization = `Bearer ${'9'.repeat(64)}`
  for (const remote of ['https://github.com/inchidev/afterprompt.git', 'https://server.example/api/compute-agent/source/00000000-0000-4000-8000-0000000000c1.git',
    'http://server.example/api/compute-agent/checkpoint/00000000-0000-4000-8000-0000000000c1.git', 'https://user:pass@server.example/api/compute-agent/checkpoint/00000000-0000-4000-8000-0000000000c1.git']) {
    await assert.rejects(pushCheckpoint({ mirror: '/nowhere', remote, authorization, sha }), /Invalid checkpoint push/u, remote)
  }
  await assert.rejects(pushCheckpoint({ mirror: '/nowhere', remote: 'https://server.example/api/compute-agent/checkpoint/00000000-0000-4000-8000-0000000000c1.git', authorization: 'Bearer short', sha }), /Invalid checkpoint push/u)
})

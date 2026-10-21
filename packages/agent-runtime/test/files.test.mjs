import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { extractRepository, prepareFiles, changedFiles, restoreFiles, proposalFiles } from '../src/files.mjs'

function tar(path, content = '', type = '0') {
  const header = Buffer.alloc(512)
  header.write(path); header.write('0000644', 100); header.write(content.length.toString(8).padStart(11, '0'), 124); header.write(type, 156)
  return gzipSync(Buffer.concat([header, Buffer.from(content), Buffer.alloc((512 - content.length % 512) % 512 + 1024)]))
}
test('bounded repository extraction rejects traversal, links, git metadata and compression bombs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'l4-files-'))
  try {
    await extractRepository(tar('repo-sha/src/a.txt', 'source'), cwd)
    assert.equal(await readFile(join(cwd, 'src/a.txt'), 'utf8'), 'source')
    for (const path of ['repo/../../escape', 'repo/.git/config', 'repo/dir/../escape']) await assert.rejects(extractRepository(tar(path, 'bad'), cwd))
    await assert.rejects(extractRepository(tar('repo/link', '', '2'), cwd))
    await assert.rejects(extractRepository(gzipSync(Buffer.alloc(200000001)), cwd))
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
test('working files retain changed, deleted and binary files, but never links or oversized output', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'l4-files-'))
  const restored = await mkdtemp(join(tmpdir(), 'l4-restore-'))
  try {
    await writeFile(join(cwd, 'gone.txt'), 'base')
    const input = { computer: true }
    await prepareFiles(input, cwd)
    await rm(join(cwd, 'gone.txt'))
    await mkdir(join(cwd, 'src')); await writeFile(join(cwd, 'src/a.txt'), 'changed')
    const archive = await changedFiles(cwd)
    assert.deepEqual(archive.files.map(file => [file.path, file.content]), [['gone.txt', null], ['src/a.txt', Buffer.from('changed').toString('base64')]])
    await restoreFiles(restored, archive)
    assert.equal(await readFile(join(restored, 'src/a.txt'), 'utf8'), 'changed')
    assert.equal((await proposalFiles(cwd))[1].content, 'changed')
    await writeFile(join(cwd, 'image.bin'), Buffer.from([255, 0, 128]))
    assert.ok((await changedFiles(cwd)).files.some(file => file.path === 'image.bin'))
    await assert.rejects(proposalFiles(cwd))
    await symlink('/tmp', join(cwd, 'link'))
    await assert.rejects(changedFiles(cwd))
    await assert.rejects(restoreFiles(restored, { version: 1, files: [{ path: '../outside', content: 'YQ==', executable: false }] }))
    await symlink('/tmp', join(restored, 'link'))
    await assert.rejects(restoreFiles(restored, { version: 1, files: [{ path: 'link/outside', content: 'YQ==', executable: false }] }))
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(restored, { recursive: true, force: true }) }
})

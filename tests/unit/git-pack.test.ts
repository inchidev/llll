import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { advertisedRefs, blob, commit, identity, objectId, pack, parsePktLines, pktLine, pushRefs, tag, tree, ZERO_SHA } from '../../server/utils/git-pack'

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const author = { name: 'Inchi', email: 'inchi@example.test' }, at = new Date('2026-11-08T12:00:00Z')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals() })
const repo = () => { const dir = mkdtempSync(join(tmpdir(), 'l4-pack-')); dirs.push(dir); git(dir, ['init', '-q', '--bare']); return dir }

describe('Git objects the Server writes', () => {
  it('hashes blobs, trees, commits and tags as Git does and packs them so Git can index the pack', async () => {
    const readme = blob('# Game\n'), readmeId = await objectId(readme)
    const root = tree([{ mode: '100644', name: 'README.md', id: readmeId }]), rootId = await objectId(root)
    const first = commit({ tree: rootId, parents: [], author, message: 'Create the repository', at }), firstId = await objectId(first)
    const release = tag({ object: firstId, name: 'v1.0.0', tagger: author, message: 'First release', at }), releaseId = await objectId(release)
    const dir = repo(), file = join(dir, 'objects.pack')
    writeFileSync(file, await pack([readme, root, first, release]))
    // Git reads the pack as a receiving repository would, checking every object against its hash.
    execFileSync('sh', ['-c', `git unpack-objects --strict < "${file}"`], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(git(dir, ['cat-file', '-t', readmeId])).toBe('blob')
    expect(git(dir, ['cat-file', '-p', rootId])).toBe(`100644 blob ${readmeId}\tREADME.md`)
    expect(git(dir, ['cat-file', '-p', firstId])).toBe(`tree ${rootId}\nauthor Inchi <inchi@example.test> 1794139200 +0000\ncommitter Inchi <inchi@example.test> 1794139200 +0000\n\nCreate the repository`)
    expect(git(dir, ['cat-file', '-t', releaseId])).toBe('tag')
    expect(git(dir, ['cat-file', '-p', releaseId])).toContain(`object ${firstId}\ntype commit\ntag v1.0.0\n`)
    // Git's own hashing agrees with ours for every object.
    for (const [id, type] of [[readmeId, 'blob'], [rootId, 'tree'], [firstId, 'commit'], [releaseId, 'tag']] as const) expect(git(dir, ['rev-parse', '--verify', `${id}^{${type}}`])).toBe(id)
  })

  it('orders tree entries as Git does, directories as if their names ended in a slash', async () => {
    const id = 'a'.repeat(40)
    const object = tree([{ mode: '100644', name: 'a.txt', id }, { mode: '040000', name: 'a', id }, { mode: '100644', name: 'a-b', id }, { mode: '100755', name: 'b', id }])
    const names = [...new TextDecoder().decode(object.body).matchAll(/\d+ ([^\0]+)\0/gu)].map(match => match[1])
    expect(names).toEqual(['a-b', 'a.txt', 'a', 'b'])
    expect(new TextDecoder().decode(object.body).startsWith('100644 a-b\0')).toBe(true)
    expect(new TextDecoder().decode(object.body)).toContain('40000 a\0')
    expect(() => tree([{ mode: '100644', name: '../x', id }])).toThrow()
    expect(() => tree([{ mode: '100644', name: '.git', id }])).toThrow()
  })

  it('keeps identities and messages on one line each', () => {
    expect(identity({ name: 'Eve <attacker>\n', email: 'a b@x.test' })).toEqual({ name: 'Eve  attacker', email: 'ab@x.test' })
    expect(identity({ name: '', email: '' })).toEqual({ name: 'L4', email: 'noreply@llll.gg' })
    const body = new TextDecoder().decode(commit({ tree: 'b'.repeat(40), parents: ['c'.repeat(40), 'd'.repeat(40)], author, message: 'Merge\r\n\r\nbody\n\n\n', at }).body)
    expect(body).toBe(`tree ${'b'.repeat(40)}\nparent ${'c'.repeat(40)}\nparent ${'d'.repeat(40)}\nauthor Inchi <inchi@example.test> 1794139200 +0000\ncommitter Inchi <inchi@example.test> 1794139200 +0000\n\nMerge\n\nbody\n`)
    expect(() => commit({ tree: 'short', parents: [], author, message: 'x' })).toThrow()
    expect(() => tag({ object: 'a'.repeat(40), name: 'v1..0', tagger: author, message: 'x' })).toThrow()
  })

  it('pushes a pack with report-status and reads the refs a repository advertises', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const head = 'e'.repeat(40), refused = { value: false }
    const transport = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      seen.push({ url: String(url), init })
      if (String(url).endsWith('/info/refs?service=git-receive-pack')) return new Response(pktLine('# service=git-receive-pack\n') + '0000' + pktLine(`${head} refs/heads/main\0report-status delete-refs\n`) + pktLine(`${'f'.repeat(40)} refs/tags/v0.1.0\n`) + pktLine(`${'1'.repeat(40)} refs/tags/v0.1.0^{}\n`) + '0000', { headers: { 'Content-Type': 'application/x-git-receive-pack-advertisement' } })
      if (refused.value) return new Response(pktLine('unpack ok\n') + pktLine('ng refs/heads/main fetch first\n') + '0000')
      return new Response(pktLine('unpack ok\n') + pktLine('ok refs/heads/main\n') + '0000', { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } })
    }) as unknown as typeof fetch
    const refs = await advertisedRefs('https://acc.artifacts.cloudflare.net/git/ns/game.git', 'art_v1_token', 'git-receive-pack', transport)
    expect([...refs]).toEqual([['refs/heads/main', head], ['refs/tags/v0.1.0', 'f'.repeat(40)]])
    expect(new Headers(seen[0]!.init.headers).get('Authorization')).toBe('Bearer art_v1_token')
    const object = commit({ tree: 'b'.repeat(40), parents: [head], author, message: 'Squash', at }), id = await objectId(object)
    expect(await pushRefs('https://acc.artifacts.cloudflare.net/git/ns/game.git', 'art_v1_token', [{ old: head, new: id, ref: 'refs/heads/main' }], [object], transport)).toEqual({ ok: true })
    const sent = seen[1]!
    expect(sent.url).toBe('https://acc.artifacts.cloudflare.net/git/ns/game.git/git-receive-pack')
    expect(new Headers(sent.init.headers).get('Content-Type')).toBe('application/x-git-receive-pack-request')
    const bytes = sent.init.body as Uint8Array
    const commands = parsePktLines(bytes.subarray(0, bytes.indexOf(0x50)))
    expect(commands).toEqual([`${head} ${id} refs/heads/main\0report-status agent=l4`])
    expect(new TextDecoder().decode(bytes.subarray(bytes.indexOf(0x50), bytes.indexOf(0x50) + 4))).toBe('PACK')
    refused.value = true
    expect(await pushRefs('https://acc.artifacts.cloudflare.net/git/ns/game.git', 't', [{ old: ZERO_SHA, new: id, ref: 'refs/tags/v1.0.0' }], [], transport)).toEqual({ ok: false, reason: 'fetch first' })
    await expect(pushRefs('https://x.test/r.git', 't', [{ old: head, new: id, ref: 'refs/heads/ma in' }], [], transport)).rejects.toThrow()
  })
})

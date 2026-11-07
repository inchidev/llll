import { describe, expect, it } from 'vitest'
import { inspectReceivePack, ownBranchRef, parseReceivePack, receivePackRefusal } from '../../shared/git-pktline'

const pkt = (line: string) => (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, '0') + line
const bytes = (text: string) => new TextEncoder().encode(text)
const zero = '0'.repeat(40), old = 'a'.repeat(40), sha = 'c'.repeat(40), ref = 'refs/heads/l4-agent/00000000-0000-4000-8000-0000000000c1'
const expected = { ref, sha }
const commands = (...lines: string[]) => lines.map((line, index) => pkt(index ? line + '\n' : line + '\0report-status side-band-64k quiet object-format=sha1 agent=git/2.47.0\n')).join('') + '0000'
const refusal = (text: string) => receivePackRefusal(parseReceivePack(bytes(text))!, expected)
const stream = (text: string, size = 7) => new ReadableStream<Uint8Array>({ start(controller) {
  const all = bytes(text)
  for (let offset = 0; offset < all.length; offset += size) controller.enqueue(all.slice(offset, offset + size))
  controller.close()
} })

describe('receive-pack commands', () => {
  it('reads the commands and capabilities at the start of a push, and waits for the rest', () => {
    const text = commands(`${old} ${sha} ${ref}`) + 'PACK'
    expect(parseReceivePack(bytes(text))).toEqual({ commands: [{ old, new: sha, ref }], capabilities: ['report-status', 'side-band-64k', 'quiet', 'object-format=sha1', 'agent=git/2.47.0'], end: text.length - 4 })
    expect(parseReceivePack(bytes(text.slice(0, 30)))).toBeNull()
    expect(parseReceivePack(bytes(text.slice(0, 2)))).toBeNull()
  })
  it('allows exactly the approved update, created or moved', () => {
    expect(refusal(commands(`${zero} ${sha} ${ref}`))).toBeNull()
    expect(refusal(commands(`${old} ${sha} ${ref}`))).toBeNull()
  })
  it.each([
    ['another ref', commands(`${old} ${sha} refs/heads/main`), /own branch/u],
    ['a tag', commands(`${zero} ${sha} refs/tags/v1`), /own branch/u],
    ['a ref that only starts like the branch', commands(`${zero} ${sha} ${ref}-x`), /own branch/u],
    ['another commit', commands(`${old} ${'d'.repeat(40)} ${ref}`), /approved commit/u],
    ['a delete', commands(`${old} ${zero} ${ref}`), /deleted/u],
    ['an extra command', commands(`${old} ${sha} ${ref}`, `${zero} ${sha} refs/heads/main`), /one ref update/u],
    ['the approved command twice', commands(`${old} ${sha} ${ref}`, `${old} ${sha} ${ref}`), /one ref update/u],
    ['no command', '0000', /No ref update/u],
    ['push options', pkt(`${old} ${sha} ${ref}\0report-status push-options\n`) + '0000', /push-options/u],
    ['a short object name', commands(`${old} ${sha.slice(0, 39)} ${ref}`), /Invalid object/u],
  ])('refuses %s', (_name, text, reason) => {
    expect(refusal(text)).toMatch(reason)
  })
  it.each([
    ['a signed push', pkt('push-cert\0report-status\n') + pkt('certificate version 0.1\n') + '0000'],
    ['a malformed length', 'zzzz' + `${old} ${sha} ${ref}`],
    ['a special packet before the flush', pkt(`${old} ${sha} ${ref}\0report-status\n`) + '0001'],
    ['a command with extra fields', commands(`${old} ${sha} ${ref} extra`)],
    ['capabilities on a later command', pkt(`${old} ${sha} ${ref}\0report-status\n`) + pkt(`${old} ${sha} ${ref}\0atomic\n`) + '0000'],
  ])('throws on %s', (_name, text) => {
    expect(() => parseReceivePack(bytes(text))).toThrow()
  })
})

describe('a Project’s Git flow', () => {
  const box = '00000000-0000-4000-8000-0000000000c1'
  it('allows the box’s own branch under any plain prefix, and nothing else', () => {
    for (const branch of [`refs/heads/l4-agent/${box}`, `refs/heads/agents/${box}`, `refs/heads/team/ai-${box}`, `refs/heads/bot_${box}`]) expect(ownBranchRef(branch, box), branch).toBe(true)
    for (const branch of [`refs/heads/${box}`, `refs/heads/l4-agent/${box}-x`, `refs/heads/l4-agent/00000000-0000-4000-8000-0000000000c2`, `refs/tags/l4-agent/${box}`,
      `refs/heads/../l4-agent/${box}`, `refs/heads/a//${box}`, `refs/heads/.x/${box}`, `refs/heads/x.lock/${box}`, `refs/heads/a@{1}/${box}`, 'refs/heads/main']) expect(ownBranchRef(branch, box), branch).toBe(false)
  })
  it('under direct_push allows the base branch only from the head the Server read', () => {
    const base = { ref: 'refs/heads/main', sha, old }
    const direct = (text: string) => receivePackRefusal(parseReceivePack(bytes(text))!, base)
    expect(direct(commands(`${old} ${sha} refs/heads/main`))).toBeNull()
    expect(direct(commands(`${'b'.repeat(40)} ${sha} refs/heads/main`))).toMatch(/move forward from the head/u)
    expect(direct(commands(`${zero} ${sha} refs/heads/main`))).toMatch(/move forward from the head/u)
    expect(direct(commands(`${old} ${'d'.repeat(40)} refs/heads/main`))).toMatch(/approved commit/u)
    expect(direct(commands(`${old} ${sha} refs/heads/release`))).toMatch(/own branch/u)
    expect(direct(commands(`${old} ${zero} refs/heads/main`))).toMatch(/deleted/u)
  })
})

describe('inspecting a push body', () => {
  it('replays the commands it read and the pack after them unchanged', async () => {
    const text = commands(`${zero} ${sha} ${ref}`) + 'PACK' + 'x'.repeat(5000)
    const inspected = await inspectReceivePack(stream(text), expected)
    expect('body' in inspected).toBe(true)
    if ('body' in inspected) expect(await new Response(inspected.body).text()).toBe(text)
  })
  it('lets Git’s empty probe through, and nothing else without an update', async () => {
    expect('body' in await inspectReceivePack(stream('0000'), expected)).toBe(true)
    expect(await inspectReceivePack(stream('0000PACK'), expected)).toEqual({ refusal: 'No ref update' })
  })
  it('refuses another update, a body that never ends its commands and one too long to read', async () => {
    expect(await inspectReceivePack(stream(commands(`${zero} ${sha} refs/heads/main`) + 'PACK'), expected)).toMatchObject({ refusal: expect.stringContaining('own branch') })
    expect(await inspectReceivePack(stream(pkt(`${zero} ${sha} ${ref}\0report-status\n`)), expected)).toMatchObject({ refusal: expect.stringContaining('Incomplete') })
    const endless = Array.from({ length: 2000 }, () => pkt(`${zero} ${sha} ${ref}\n`)).join('')
    expect(await inspectReceivePack(stream(endless, 4096), expected)).toMatchObject({ refusal: expect.stringContaining('Incomplete') })
    expect(await inspectReceivePack(null, expected)).toEqual({ refusal: 'No ref update' })
  })
})

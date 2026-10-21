import { mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'

const exec = promisify(execFile)
export const safeFile = path => typeof path === 'string' && path.length > 0 && path.length <= 500 && !path.startsWith('/') && !path.includes('\\')
  && ![...path].some(c => c.charCodeAt(0) < 32) && path.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git')
export async function git(cwd, ...args) { return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: 2100000 })).stdout }
async function download(url, token, limit, signal) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error' })
  if (!response.ok) throw new Error(`Files unavailable (${response.status})`)
  let bytes = 0
  const chunks = []
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw new Error('File download limit exceeded'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
/** Extract only bounded ordinary files/directories. Links and special tar entries never enter compute. */
export async function extractRepository(compressed, cwd) {
  const bytes = gunzipSync(compressed, { maxOutputLength: 200000000 })
  const text = value => value.toString('utf8').replace(/\0.*$/su, '')
  let count = 0
  let pax = {}
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) break
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) throw new Error('Invalid repository archive')
    const body = bytes.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    const type = String.fromCharCode(header[156])
    if (type === 'g' || type === 'x') {
      if (size > 10000) throw new Error('Archive metadata limit exceeded')
      for (let position = 0; position < body.length;) {
        const space = body.indexOf(32, position)
        const length = Number(body.subarray(position, space).toString())
        if (space < 0 || !Number.isSafeInteger(length) || length <= 0 || position + length > body.length) throw new Error('Invalid archive metadata')
        const record = body.subarray(space + 1, position + length - 1).toString()
        const equal = record.indexOf('=')
        if (type === 'x') pax[record.slice(0, equal)] = record.slice(equal + 1)
        position += length
      }
      continue
    }
    const prefix = text(header.subarray(345, 500))
    const path = (pax.path ?? (prefix ? prefix + '/' : '') + text(header.subarray(0, 100))).replace(/\/$/u, '').split('/').slice(1).join('/')
    pax = {}
    if (!path && type === '5') continue
    if (!safeFile(path) || ++count > 10000 || !['0', '\0', '5'].includes(type)) throw new Error('Repository contains unsupported links, paths or special files')
    const target = join(cwd, path)
    await mkdir(type === '5' ? target : dirname(target), { recursive: true })
    if (type !== '5') await writeFile(target, body, { mode: Number.parseInt(text(header.subarray(100, 108)).trim() || '644', 8) & 0o111 ? 0o755 : 0o644 })
  }
}
export async function prepareFiles(input, cwd, signal) {
  if (!input.computer) return
  await mkdir(cwd, { recursive: true })
  if (input.repository) await extractRepository(await download(input.repository.archiveUrl, input.modelGateway.token, 20000000, signal), cwd)
  await git(cwd, 'init', '-q')
  await git(cwd, 'add', '--all')
  await git(cwd, '-c', 'user.name=L4 Agent', '-c', 'user.email=agent@localhost', 'commit', '--allow-empty', '-qm', 'Execution base')
  if (input.filesUrl) await restoreFiles(cwd, JSON.parse((await download(input.filesUrl, input.modelGateway.token, 2000000, signal)).toString()))
}
export async function changedFiles(cwd) {
  const paths = new Set((await git(cwd, 'diff', '--name-only', '-z', 'HEAD')).split('\0').filter(Boolean))
  for (const path of (await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean)) paths.add(path)
  // Index changes are included in diff HEAD; ignore rules keep dependency/cache directories out.
  const files = []
  for (const path of paths) {
    if (!safeFile(path) || files.length >= 100) throw new Error('Working files exceed the archive limit')
    const target = join(cwd, path)
    let content = null, executable = false
    try {
      const stat = await lstat(target)
      if (!stat.isFile() || stat.size > 500000) throw new Error('Working files must be bounded ordinary files')
      content = (await readFile(target)).toString('base64'); executable = Boolean(stat.mode & 0o111)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    files.push({ path, content, executable })
  }
  const archive = { version: 1, files }
  if (Buffer.byteLength(JSON.stringify(archive)) > 2000000) throw new Error('Working files exceed the archive limit')
  return archive
}
export async function restoreFiles(cwd, archive) {
  if (archive?.version !== 1 || !Array.isArray(archive.files) || archive.files.length > 100 || Buffer.byteLength(JSON.stringify(archive)) > 2000000) throw new Error('Invalid working files archive')
  for (const file of archive.files) {
    if (!safeFile(file.path) || (file.content !== null && (typeof file.content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(file.content)))) throw new Error('Invalid working file')
    const target = join(cwd, file.path)
    // Repository extraction never creates links; refuse links introduced by restored files too.
    for (let parent = dirname(target); parent !== cwd; parent = dirname(parent)) {
      try { if (!(await lstat(parent)).isDirectory()) throw new Error('Invalid parent directory') } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (file.content === null) await rm(target, { force: true })
    else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.from(file.content, 'base64'), { mode: file.executable ? 0o755 : 0o644, flag: 'wx' }).catch(async error => { if (error.code !== 'EEXIST' || !(await lstat(target)).isFile()) throw error; await writeFile(target, Buffer.from(file.content, 'base64')) }) }
  }
}
export async function proposalFiles(cwd) {
  const archive = await changedFiles(cwd)
  return archive.files.map(file => ({ ...file, content: file.content === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.content, 'base64')) }))
}

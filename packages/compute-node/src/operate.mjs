import { spawn } from 'node:child_process'
import { open, mkdir, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, dirname } from 'node:path'

export function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 400 && !path.startsWith('/') && !path.includes('\\') && ![...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && path.split('/').every(part => part && part !== '.' && part !== '..' && !['.git','.github'].includes(part.toLowerCase()))
}
export async function runProcess(command, args, { cwd, input, limit = 400000, timeoutMs = 120000, signal, env } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe','pipe','pipe'], signal })
    let total = 0, limited = false
    const chunks = [], errors = []
    const collect = (target, chunk) => { total += chunk.length; if (total > limit) { limited = true; child.kill('SIGKILL') } else target.push(chunk) }
    child.stdout.on('data', chunk => collect(chunks, chunk)); child.stderr.on('data', chunk => collect(errors, chunk))
    const timeout = setTimeout(() => { limited = true; child.kill('SIGKILL') }, timeoutMs)
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => { clearTimeout(timeout); if (limited) reject(new Error('Process output or time limit reached')); else resolveResult({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors) }) })
    child.stdin.on('error', () => {}); child.stdin.end(input)
  })
}
const git = async (cwd, ...args) => {
  const result = await runProcess('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.quotePath=false',...args], { cwd })
  if (result.code !== 0) throw new Error('Git operation failed; review the checkout and command evidence')
  return result.stdout
}
async function scopedFile(root, path, create = false) {
  if (!safePath(path)) throw new Error('Protected path')
  const file = resolve(root, path)
  let current = root
  for (const part of path.split('/').slice(0,-1)) {
    current = resolve(current,part)
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe directory') }
    catch (error) { if (create && error.code === 'ENOENT') await mkdir(current); else throw error }
  }
  try { if ((await lstat(file)).isSymbolicLink()) throw new Error('Symlink files are unavailable') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!(await realpath(dirname(file))).startsWith(root)) throw new Error('File escaped workspace')
  return file
}
function identity(raw) {
  const match = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/u.exec(raw)
  if (!match) throw new Error('Unsupported commit identity')
  const offset = (Number(match[4].slice(1,3)) * 60 + Number(match[4].slice(3))) * (match[4][0] === '-' ? -1 : 1)
  return { name: match[1], email: match[2], date: new Date((Number(match[3]) + offset * 60) * 1000).toISOString().slice(0,19) + match[4].slice(0,3) + ':' + match[4].slice(3) }
}
async function changed(cwd, from, to) {
  const entries = (await git(cwd,'diff','--name-status','-z','--no-renames',from,to)).toString().split('\0').filter(Boolean), files = []
  for (let index = 0; index < entries.length; index += 2) {
    const [status,path] = entries.slice(index,index+2)
    if (!safePath(path)) throw new Error('Proposal changes a protected path')
    if (status === 'D') { files.push({ path, content: null, executable: false }); continue }
    const mode = (await git(cwd,'ls-tree',to,'--',path)).toString().split(' ')[0]
    if (!['100644','100755'].includes(mode)) throw new Error('Only ordinary text files can be proposed')
    const bytes = await git(cwd,'show',`${to}:${path}`)
    if (bytes.length > 80000 || bytes.includes(0)) throw new Error('Proposal file is binary or too large')
    files.push({ path, content: new TextDecoder('utf-8',{fatal:true}).decode(bytes), executable: mode === '100755' })
  }
  if (!files.length || files.length > 100 || Buffer.byteLength(JSON.stringify(files)) > 85000) throw new Error('Commit changes exceed proposal limits')
  return files
}
export async function snapshot(cwd, baseSha) {
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) throw new Error('Invalid base')
  if ((await git(cwd,'status','--porcelain','-z')).length) throw new Error('Commit all intended changes before snapshotting; the checkout must be clean')
  await git(cwd,'merge-base','--is-ancestor',baseSha,'HEAD')
  const ids = (await git(cwd,'rev-list','--reverse',`${baseSha}..HEAD`)).toString().trim().split('\n').filter(Boolean)
  if (!ids.length || ids.length > 20) throw new Error('Snapshot needs one to twenty local commits')
  const commits = []
  let parent = baseSha
  for (const sha of ids) {
    const raw = (await git(cwd,'cat-file','commit',sha)).toString(), boundary = raw.indexOf('\n\n'), headers = raw.slice(0,boundary).split('\n')
    if (headers.some(line => line.startsWith('gpgsig ') || line.startsWith(' '))) throw new Error('Signed or extended commit headers are unsupported in MVP')
    const values = key => headers.filter(line => line.startsWith(key+' ')).map(line => line.slice(key.length+1))
    const parents = values('parent')
    if (parents.length !== 1 || parents[0] !== parent) throw new Error('Publication requires linear commits from the pinned base')
    commits.push({ sha, tree: values('tree')[0], parents, message: raw.slice(boundary+2), author: identity(values('author')[0]), committer: identity(values('committer')[0]), files: await changed(cwd,parent,sha) })
    parent = sha
  }
  const result = { baseSha, headSha: parent, treeSha: commits.at(-1).tree, commits, files: await changed(cwd,baseSha,parent), diff: (await git(cwd,'diff','--no-ext-diff','--no-textconv',baseSha,parent)).toString(), evidence: [] }
  if (Buffer.byteLength(JSON.stringify(result)) > 340000) throw new Error('Split this snapshot into smaller changes')
  return result
}
export async function operate(job, root = '/workspace/repo') {
  const input = job.request
  if (input.operation === 'bootstrap') {
    await git('/workspace','clone','--no-checkout','/bootstrap/source.bundle','repo')
    await git(root,'checkout','-b','work',job.baseSha)
    await git(root,'remote','remove','origin')
    await git(root,'config','user.name','L4 Agent'); await git(root,'config','user.email','agent@local.invalid')
    await git(root,'config','core.hooksPath','/dev/null')
    return { ok: true, exitCode: 0, output: `Pinned checkout ${job.baseSha}` }
  }
  if (input.operation === 'read') {
    const path = await scopedFile(root,input.path)
    const file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 60000) throw new Error('File size or type unavailable')
      // Check and read the same inode; keep the read bounded even if it grows.
      const content = Buffer.alloc(60001)
      let bytes = 0
      while (bytes < content.length) {
        const read = await file.read(content,bytes,content.length-bytes,null)
        if (!read.bytesRead) break
        bytes += read.bytesRead
      }
      if (bytes > 60000) throw new Error('File size or type unavailable')
      return { ok: true, exitCode: 0, output: new TextDecoder('utf-8',{fatal:true}).decode(content.subarray(0,bytes)) }
    } finally { await file.close() }
  }
  if (input.operation === 'write') {
    const file = await open(await scopedFile(root,input.path,true),constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,0o644)
    try {
      if (!(await file.stat()).isFile()) throw new Error('File type unavailable')
      await file.truncate(0)
      await file.writeFile(input.content)
    } finally { await file.close() }
    return { ok: true, exitCode: 0, output: `Wrote ${input.path}` }
  }
  if (input.operation === 'snapshot') return { ok: true, exitCode: 0, output: 'Exact committed snapshot', snapshot: await snapshot(root,job.baseSha) }
  if (input.operation === 'suspend') return { ok: true, exitCode: 0, output: 'Workspace disk retained; no command process remains active' }
  if (input.operation === 'exec') {
    const result = await runProcess('/bin/sh',['-lc',input.command],{cwd:root,timeoutMs:input.timeoutMs,limit:62000})
    return { ok: result.code === 0, exitCode: result.code, output: Buffer.concat([result.stdout,result.stderr]).toString() }
  }
  throw new Error('Unsupported workspace operation')
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const chunks = []; let bytes = 0
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 100000) throw new Error('Input limit reached'); chunks.push(chunk) }
    process.stdout.write(JSON.stringify(await operate(JSON.parse(Buffer.concat(chunks).toString()))))
  } catch { process.stdout.write(JSON.stringify({ ok:false,exitCode:-1,output:'Workspace operation failed. Inspect the approved command, checkout state and limits.' })) }
}

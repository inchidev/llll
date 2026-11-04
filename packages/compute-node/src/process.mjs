import { spawn } from 'node:child_process'

const tools = Object.freeze(Object.assign(Object.create(null), {
  git: 'git', docker: 'docker', fallocate: 'fallocate', 'mkfs.ext4': 'mkfs.ext4',
  mount: 'mount', umount: 'umount', findmnt: 'findmnt', losetup: 'losetup', sync: 'sync',
}))
const trustedPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export function collectProcess(child, { input, limit = 400000, timeoutMs = 120000 } = {}) {
  return new Promise((resolveResult, reject) => {
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

/** Host tools receive argv only. No shell or arbitrary executable is available here. */
export async function runProcess(tool, args, options = {}) {
  if (!Object.hasOwn(tools, tool) || !Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Unsupported host process')
  const { cwd, signal, env } = options
  const child = spawn(tools[tool], args, { cwd, env: { ...process.env, ...env, PATH: trustedPath }, stdio: ['pipe','pipe','pipe'], shell: false, signal })
  return collectProcess(child, options)
}

import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cloudCodeBridge } from '../../workers/factory-code-bridge'

function execute(program: string, chunks: Buffer[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value })
    child.stderr.on('data', value => { stderr += value })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.stdin.on('error', () => {})
    for (const chunk of chunks) child.stdin.write(chunk)
    child.stdin.end()
  })
}

const helper = new URL('../../packages/compute-node/src/cloud-io.mjs', import.meta.url).href
const reader = `import {readCodeInput} from ${JSON.stringify(helper)};try {process.stdout.write(await readCodeInput())} catch {process.exitCode=1}`

it('reads a real child-process stdin transport without reopening /dev/stdin', async () => {
  // Linux child-process stdio uses a Unix socket; reopening /dev/stdin yields ENXIO.
  const input = Buffer.from(JSON.stringify({ operation: 'bootstrap', note: 'Строка 👋' }))
  const result = await execute(reader, [input.subarray(0, 29), input.subarray(29)])
  expect(result).toEqual({ code: 0, stdout: input.toString(), stderr: '' })
})

it('bounds the helper input by bytes while reading the transport', async () => {
  expect((await execute(reader, [Buffer.alloc(8000, 65)])).code).toBe(0)
  expect((await execute(reader, [Buffer.alloc(7999, 65), Buffer.from('👋')])).code).toBe(1)
})

it('uses the streaming bridge with a legacy helper export and rejects oversized requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'l4-code-bridge-'))
  try {
    const module = join(directory, 'legacy.mjs')
    await writeFile(module, 'export async function codeState(input){return {ok:true,input}}')
    const bridge = cloudCodeBridge.replace('file:///opt/l4/cloud-io.mjs', pathToFileURL(module).href)
    const input = { operation: 'bootstrap', baseSha: 'a'.repeat(40) }
    const result = await execute(bridge, [Buffer.from(JSON.stringify(input))])
    expect(result.code).toBe(0); expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, input })
    const denied = await execute(bridge, [Buffer.alloc(8001, 65)])
    expect(JSON.parse(denied.stdout)).toMatchObject({ ok: false })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

import { afterEach, expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const children: ChildProcess[] = []
const directories: string[] = []
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

it('resumes SQLite work after SIGKILL mid-tool without repeating an input or an external write', async () => {
  await mkdir(resolve('.deployment'), { recursive: true })
  const dir = await mkdtemp(resolve('.deployment/pi-recovery-'))
  directories.push(dir)
  const entry = resolve(dir, 'fixture.mjs')
  await build({
    stdin: { contents: `
      import fs from 'node:fs';
      import { runEmbeddedPi } from './workers/agent-pi-durable.ts';
      const ledger = process.env.PI_TEST_DIR + '/ledger.json';
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (String(url).endsWith('/tools')) {
          const saved = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')) : {};
          if (!saved[body.callId]) { saved[body.callId] = { writes: 1, result: 'Created exactly once' }; fs.writeFileSync(ledger, JSON.stringify(saved)); }
          if (process.env.PI_TEST_CRASH === '1') { process.send({ ready: true }); return new Promise(() => {}); }
          return Response.json(saved[body.callId].result);
        }
        const hasResult = body.messages.some(m => m.role === 'tool');
        const delta = hasResult ? { role: 'assistant', content: 'Recovered successfully' }
          : { role: 'assistant', tool_calls: [{ index: 0, id: 'stable-write', type: 'function', function: { name: 'create_fixture', arguments: '{}' } }] };
        const frame = (d, f) => 'data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: f }] }) + '\\n\\n';
        return new Response(frame(delta, null) + frame({}, hasResult ? 'stop' : 'tool_calls') + 'data: [DONE]\\n\\n', { headers: { 'Content-Type': 'text/event-stream' } });
      };
      const input = { runId: 'same-run', prompt: 'Create the fixture once', instructions: 'Use the tool once.',
        tools: [{ name: 'create_fixture', description: 'Create fixture', parameters: { type: 'object', properties: {} } }],
        toolEndpoint: 'https://fixture.invalid/tools', modelGateway: { url: 'https://fixture.invalid/v1', token: 'fixture', model: 'test' } };
      const outcome = await runEmbeddedPi(input, {});
      process.send({ outcome });
      process.disconnect();
    `, resolveDir: process.cwd(), sourcefile: 'recovery-fixture.ts', loader: 'ts' },
    outfile: entry, bundle: true, format: 'esm', platform: 'node', packages: 'external',
    plugins: [{ name: 'sqlite-host', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-durable\/storage\/sqlite\/cloudflare$/ }, () => ({ path: 'sqlite-host', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'; export const openDurableObjectSqliteStorage = () => openNodeSqliteStorage(process.env.PI_TEST_DIR + '/pi.sqlite');`, resolveDir: process.cwd(), loader: 'js' }))
    } }],
  })
  function launch(crash: boolean) {
    const child = spawn(process.execPath, [entry], { env: { ...process.env, PI_TEST_DIR: dir, PI_TEST_CRASH: crash ? '1' : '0' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    children.push(child)
    let error = ''
    child.stderr!.on('data', chunk => { error += chunk })
    const message = new Promise<Record<string, unknown>>((resolveMessage, reject) => {
      child.once('message', value => resolveMessage(value as Record<string, unknown>))
      child.once('exit', code => { if (code) reject(new Error(error)) })
      child.once('error', reject)
    })
    return { child, message }
  }
  const first = launch(true)
  expect(await first.message).toEqual({ ready: true })
  first.child.kill('SIGKILL')
  await new Promise(resolveExit => first.child.once('exit', resolveExit))
  const second = launch(false)
  const result = await second.message as { outcome: { result: unknown; transcript: string } }
  expect(result.outcome.result).toMatchObject({ type: 'result', text: 'Recovered successfully' })
  const messages = result.outcome.transcript.split('\n').flatMap(line => JSON.parse(line).model ?? [])
  expect(messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1)
  expect(JSON.parse(await readFile(resolve(dir, 'ledger.json'), 'utf8'))).toEqual({ 'stable-write': { writes: 1, result: 'Created exactly once' } })
}, 15000)

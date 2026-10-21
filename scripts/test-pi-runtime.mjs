import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'

const exec = promisify(execFile)
const context = process.env.LLLL_TEST_DOCKER_CONTEXT
const command = (...args) => exec('docker', [...(context ? ['--context', context] : []), ...args], { maxBuffer: 2_000_000 })
const suffix = randomUUID().slice(0, 8)
const network = `llll-pi-test-${suffix}`
const gateway = `${network}-gateway`
const agent = `${network}-agent`
const directory = await mkdtemp(join(tmpdir(), network))
const token = randomBytes(32).toString('hex')
const runner = `${network}-runner`
const runnerToken = randomBytes(32).toString('hex')
const serverId = randomUUID()
const secondId = randomUUID()
const image = process.env.LLLL_TEST_PI_IMAGE || 'llll-agent:pi-1.3.0'
const fixture = `
const http = require('node:http'); let calls=0; let tools=0;
http.createServer(async (req,res)=>{
 if(req.method==='GET'&&req.url==='/tools'){res.writeHead(405).end();return;}
 let body='';for await(const chunk of req)body+=chunk;
 if(req.url==='/stats'){res.end(JSON.stringify({calls,tools}));return;}
 if(req.url==='/tools'){tools++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({evidence:'Fixture source'}));return;}
 const input=JSON.parse(body);calls++;
 if(JSON.stringify(input.messages).includes('Wait for cancellation'))return;
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const used=input.messages.some(m=>m.role==='tool');
 const delta=used?{role:'assistant',content:'Evidence preserved'}:{role:'assistant',tool_calls:[{index:0,id:'fixture-call',type:'function',function:{name:'read_evidence',arguments:'{}'}}]};
 for(const choice of [{delta,finish_reason:null},{delta:{},finish_reason:used?'stop':'tool_calls'}])res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,...choice}]})+'\\n\\n');
 res.end('data: [DONE]\\n\\n');
}).listen(80,'0.0.0.0');`
const runId = randomUUID()
const sessionId = randomUUID()
try {
  await writeFile(join(directory, 'gateway.cjs'), fixture)
  await command('network', 'create', '--internal', '--label', 'llll.test=pi-runtime', network)
  await command('run', '-d', '--name', gateway, '--network', network, '--network-alias', 'gateway', '--label', 'llll.test=pi-runtime',
    'node:24.21.0-bookworm-slim', 'node', '-e', fixture)
  await command('run', '-d', '--name', agent, '--network', network, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '1g', '--cpus', '1',
    '--label', 'llll.test=pi-runtime', '--tmpfs', '/data:rw,nosuid,size=512m,uid=1000,gid=1000', '--env', `LLLL_RUN_TOKEN=${token}`, image)
  const info = JSON.parse((await command('inspect', agent)).stdout)[0]
  assert.equal(info.HostConfig.ReadonlyRootfs, true)
  assert.equal(info.Config.User, 'node')
  assert.ok(info.HostConfig.Tmpfs['/data'].includes('size=512m'))
  assert.ok(!info.Mounts.some(mount => mount.Source.includes('docker.sock')))
  let runnerMode = false
  const request = async (path, method = 'GET', body, authorized = true) => {
    const execute = `fetch(${JSON.stringify(runnerMode ? `http://${runner}:8081/runs/${secondId}` : `http://${agent}:8080`)}+${JSON.stringify(path)},${JSON.stringify({ method, headers: { ...(authorized ? { Authorization: `Bearer ${runnerMode ? runnerToken : token}` } : {}), ...(runnerMode ? { 'x-run-capability': token } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })})
      .then(async r=>console.log(JSON.stringify({status:r.status,text:await r.text()}))).catch(()=>process.exit(2))`
    const result = JSON.parse((await command('exec', gateway, 'node', '-e', execute)).stdout)
    return new Response(result.status === 204 ? null : result.text, { status: result.status })
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await request('/health')).ok) break } catch { /* Wait for readiness. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal((await request('/health', 'GET', undefined, false)).status, 401)
  const input = { runId, sessionId, prompt: 'Read the evidence and report it', instructions: 'Use read_evidence before answering.',
    modelGateway: { url: 'http://gateway/v1', token, model: 'fixture' }, toolEndpoint: 'http://gateway/tools',
    tools: [{ name: 'read_evidence', description: 'Read evidence', parameters: { type: 'object', properties: {} } }],
    computer: false, maxSteps: 5, timeoutMs: 30000 }
  assert.equal((await request('/run', 'POST', input)).status, 202)
  let result
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await (await request('/run')).json()
    if (result.status === 'finished') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(result.result.type, 'result', JSON.stringify(result))
  assert.equal(result.result.text, 'Evidence preserved')
  assert.ok(result.events.some(event => event.type === 'tool'))
  const archive = await (await request('/session')).json()
  assert.ok(archive.transcript.includes('Fixture source'))
  assert.equal((await request('/run', 'POST', input)).status, 202)
  const stats = JSON.parse((await command('exec', gateway, 'node', '-e', "fetch('http://127.0.0.1/stats').then(r=>r.text()).then(console.log)")).stdout)
  assert.equal(stats.tools, 1, 'Duplicate admission repeated a side effect')
  await command('restart', agent)
  for (let attempt = 0; attempt < 100; attempt++) {
    try { result = await (await request('/run')).json(); break } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  assert.equal(result.status, 'idle', 'Ephemeral compute loss must be reported to the durable coordinator, never silently resumed')
  const isolated = await command('exec', agent, 'node', '-e', "fetch('https://example.com',{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(1)).catch(()=>console.log('egress denied'))")
  assert.ok(isolated.stdout.includes('egress denied'))
  await command('run', '-d', '--name', runner, '--network', network, '--label', 'llll.test=pi-runtime',
    '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    '--env', `LLLL_RUNNER_TOKEN=${runnerToken}`, '--env', `LLLL_SERVER_ID=${serverId}`,
    '--env', `LLLL_AGENT_NETWORK=${network}`, '--env', `LLLL_AGENT_IMAGE=${image}`, 'llll-agent-runner:local')
  runnerMode = true
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal((await request('/health')).status, 200)
  assert.equal((await (await request('/run')).json()).status, 'idle', 'Readiness must not submit work')
  assert.equal((await request('/run', 'POST', { ...input, runId: secondId, prompt: 'Wait for cancellation' })).status, 202)
  assert.equal((await request('/run', 'DELETE')).status, 202)
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await (await request('/run')).json()
    if (result.status === 'finished') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(result.status, 'finished', 'Cancellation did not stop Pi')
  assert.equal((await request('/lifecycle', 'DELETE')).status, 204)
  assert.equal((await request('/lifecycle', 'DELETE')).status, 204, 'Cleanup must be idempotent')
  await assert.rejects(command('inspect', `llll-agent-${secondId}`))
  await assert.rejects(command('volume', 'inspect', `llll-agent-${secondId}-data`))
  console.log('PASS: real Pi in an unprivileged Docker container, private network, model/tool gateway, events, evidence archive, duplicate admission, fail-closed restart, Runner cancellation and bounded cleanup')
} finally {
  for (const name of [agent, runner, `llll-agent-${secondId}`, gateway]) await command('rm', '-f', '-v', name).catch(() => {})
  await command('volume', 'rm', `llll-agent-${secondId}-data`).catch(() => {})
  await command('network', 'rm', network).catch(() => {})
  await rm(directory, { recursive: true, force: true })
}

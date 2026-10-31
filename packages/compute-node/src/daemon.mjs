import { LoopDiskStore } from './disk-store.mjs'
import { join, resolve } from 'node:path'
import { runProcess } from './process.mjs'
import { openNodeState, serverOrigin } from './state-store.mjs'

const state = resolve(process.env.LLLL_NODE_STATE || './compute-node-state')
const image = process.env.LLLL_WORKSPACE_IMAGE
const configuredDiskBytes = Number(process.env.LLLL_WORKSPACE_DISK_BYTES || 10737418240)
if (![1073741824, 10737418240].includes(configuredDiskBytes)) throw new Error('LLLL_WORKSPACE_DISK_BYTES must be 1073741824 or 10737418240')
if (!/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/u.test(image ?? '')) throw new Error('Set LLLL_WORKSPACE_IMAGE to an immutable registry digest')
if (process.env.LLLL_SHARED_KERNEL_TRUSTED !== '1') throw new Error('Docker shares the host kernel. Confirm trusted-code use with LLLL_SHARED_KERNEL_TRUSTED=1; public untrusted tenants require a stronger provider')
process.umask(0o077)
const server = serverOrigin(process.env.LLLL_SERVER_ORIGIN)
const store = await openNodeState(state)
const workspaceDisks = new LoopDiskStore(join(state,'workspace-disks'))
const sourceDisks = new LoopDiskStore(join(state,'source-disks'),{bytes:536870912,maxDisks:1})
await workspaceDisks.initialize(); await sourceDisks.initialize()
const probe = new LoopDiskStore(join(state,'probe-disks'),{bytes:33554432,maxDisks:1})
await probe.initialize()
const probeId = crypto.randomUUID()
try { await probe.cleanup(); await probe.ensure(probeId,true) } finally { await probe.remove(probeId) }
const capabilities = { ...(process.env.LLLL_COMPUTE_PROVIDER === 'lizard' ? {provider:'lizard'} : {}), diskBytes:configuredDiskBytes,docker:true,durableDisk:true,isolation:'shared-kernel',image,maxParallel:1,protocol:1 }
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay,ms))
const docker = async (args,options={}) => {
  const result = await runProcess('docker',args,options)
  if (result.code !== 0) throw new Error('Docker operation failed')
  return result.stdout.toString()
}
async function request(server,path,body,token) {
  const response = await fetch(server+path,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)})
  if (!response.ok) throw Object.assign(new Error('Server rejected Node operation'),{status:response.status})
  const chunks=[];let bytes=0
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>420000)throw new Error('Server response limit reached');chunks.push(chunk)}
  return JSON.parse(Buffer.concat(chunks).toString())
}
let connection = store.connection(server)
if (!connection) {
  const token=process.env.LLLL_PAIRING_TOKEN
  if (!/^[a-f0-9]{64}$/u.test(token??'')) throw new Error('Set a one-use LLLL_PAIRING_TOKEN from Server Settings → Repositories → Compute Nodes')
  const paired=await request(server,'/api/compute-agent/pair',{token,capabilities})
  store.pair(server,paired)
  connection=store.connection(server)
}
const poll=body=>request(server,'/api/compute-agent/poll',body,connection.token)
await docker(['info','--format','{{.ServerVersion}}'])
await docker(['image','inspect',image])
// Only this paired Node's containers. A restart never resumes an uncertain command.
const leftovers=(await docker(['ps','-aq','--filter',`label=l4.node=${connection.nodeId}`,'--filter',`label=l4.server=${connection.serverId}`])).trim().split('\n').filter(Boolean)
for (const id of leftovers) await docker(['rm','-f',id])
await sourceDisks.cleanup()

async function revokeSource(job) {
  if(typeof job.sourceToken!=='string')return
  const token=job.sourceToken;delete job.sourceToken
  try { await fetch('https://api.github.com/installation/token',{method:'DELETE',redirect:'manual',headers:{Authorization:`Bearer ${token}`,'User-Agent':'L4-source-broker'},signal:AbortSignal.timeout(10000)}) } catch { /* Expiring single-repository read grant is never reused. */ }
}
async function sourceBundle(job,signal) {
  // A Gitea source is fetched through the Server with a lease-bound capability; nothing is revoked at GitHub.
  const brokered=job.source&&typeof job.source.remote==='string'&&new URL(job.source.remote).origin===new URL(server).origin
  if (!/^[\w.-]+\/[\w.-]+$/u.test(job.repository) || !/^[a-f0-9]{40}$/u.test(job.baseSha) || (!brokered && typeof job.sourceToken!=='string')) throw new Error('Invalid pinned source grant')
  const name=`l4-fetch-${job.id}`
  let directory
  try {
    directory=await sourceDisks.ensure(job.id,true)
    const ca=process.env.LLLL_SOURCE_CA||process.env.NODE_EXTRA_CA_CERTS
    const output=await docker(['run','--rm','-i','--name',name,'--label',`l4.node=${connection.nodeId}`,'--label',`l4.server=${connection.serverId}`,
      '--network','bridge','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','512m','--cpus','1',
      '--tmpfs','/tmp:rw,noexec,nosuid,size=32m,uid=1000,gid=1000','--mount',`type=bind,src=${directory},dst=/source`,
      ...(ca?['--mount',`type=bind,src=${resolve(ca)},dst=/run/source-ca.pem,readonly`,'--env','GIT_SSL_CAINFO=/run/source-ca.pem']:[]),image,'node','/opt/l4/fetch-source.mjs'],
      {input:JSON.stringify(brokered?{baseSha:job.baseSha,remote:job.source.remote,authorization:job.source.authorization}:{repository:job.repository,baseSha:job.baseSha,token:job.sourceToken}),signal,timeoutMs:120000,limit:10000})
    if(!JSON.parse(output).ok)throw new Error('Pinned source broker failed')
    return {diskId:job.id,directory,bundle:join(directory,'source.bundle')}
  } catch(error) {
    await docker(['rm','-f',name]).catch(()=>{})
    if(directory)await sourceDisks.remove(job.id).catch(()=>{})
    throw new Error('Source broker fetch or capacity check failed',{cause:error})
  } finally {
    await revokeSource(job)
    delete job.source
  }
}
async function execute(job,controller) {
  if (job.serverId!==connection.serverId || job.image!==image || !/^[a-f0-9-]{36}$/u.test(job.workspaceId)) throw new Error('Workspace identity or pinned image mismatch')
  // Older Servers omit the disk policy and only support 1 GiB. An updated
  // daemon must keep the paired Node's existing quota and retained disks.
  const diskBytes = job.diskBytes ?? 1073741824
  if (![1073741824, 10737418240].includes(diskBytes)) throw new Error('Unsupported workspace disk policy')
  const taskDisks = new LoopDiskStore(workspaceDisks.root, { bytes: diskBytes })
  const volume=`l4-ws-${job.workspaceId}`,name=`l4-op-${job.id}`,network=`l4-net-${job.id}`,proxy=`l4-proxy-${job.id}`
  const labels=['--label',`l4.node=${connection.nodeId}`,'--label',`l4.server=${connection.serverId}`,'--label',`l4.workspace=${job.workspaceId}`,'--label',`l4.task=${job.taskId}`]
  let source,networkCreated=false
  const started=Date.now()
  const cleanup=async()=>{
    await docker(['rm','-f',name]).catch(()=>{})
    await docker(['rm','-f',proxy]).catch(()=>{})
    if(networkCreated)await docker(['network','rm',network]).catch(()=>{})
    if(source)await sourceDisks.remove(source.diskId)
  }
  const stop=()=>{void cleanup()}
  controller.signal.addEventListener('abort',stop,{once:true})
  try {
    let existing
    try { existing=JSON.parse(await docker(['volume','inspect',volume]))[0] } catch { /* Missing volume only. */ }
    if (existing && (existing.Labels?.['l4.server']!==connection.serverId || existing.Labels?.['l4.node']!==connection.nodeId || existing.Labels?.['l4.workspace']!==job.workspaceId || existing.Labels?.['l4.task']!==job.taskId)) throw new Error('Foreign workspace volume')
    if (!existing && job.request.operation!=='bootstrap') throw new Error('Workspace disk is unavailable on this Node')
    if (job.request.operation==='release') { if(existing)await docker(['volume','rm',volume]); await taskDisks.remove(job.workspaceId); return {ok:true,exitCode:0,output:'Workspace disk explicitly released',runtimeMs:Date.now()-started} }
    const mountPath=await taskDisks.ensure(job.workspaceId,job.request.operation==='bootstrap')
    if(existing && (existing.Driver!=='local'||existing.Options?.device!==mountPath))throw new Error('Workspace volume is not bound to its hard-quota disk')
    if (!existing)await docker(['volume','create',...labels,'--driver','local','--opt','type=none','--opt','o=bind','--opt',`device=${mountPath}`,volume])
    if(job.request.operation==='bootstrap')source=await sourceBundle(job,controller.signal)
    if(controller.signal.aborted)throw new Error('Operation revoked')
    const proxyEnv=[],hosts=job.request.operation==='exec'?job.request.networkHosts:[]
    let networkArg='none',proxyAddress=''
    if(hosts.length){
      await docker(['network','create','--internal','--opt','com.docker.network.bridge.inhibit_ipv4=true',...labels,network]);networkCreated=true;networkArg=network
      await docker(['run','-d','--name',proxy,...labels,'--network',network,'--network-alias','l4-egress','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','64m','--pids-limit','32','--env',`LLLL_EGRESS_HOSTS=${JSON.stringify(hosts)}`,'--env','HTTP_PROXY=','--env','HTTPS_PROXY=','--env','ALL_PROXY=',image,'node','/opt/l4/proxy.mjs'])
      await docker(['network','connect','bridge',proxy])
      const inspected=JSON.parse(await docker(['inspect',proxy]))[0]
      const ip=inspected.NetworkSettings.Networks[network].IPAddress
      proxyAddress=`http://${ip}:8080`
    }
    for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','FTP_PROXY','ftp_proxy'])proxyEnv.push('--env',`${key}=${proxyAddress}`)
    proxyEnv.push('--env','NO_PROXY=','--env','no_proxy=')
    const args=['run','--rm','-i','--name',name,...labels,'--network',networkArg,'--dns','127.0.0.1','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','1g','--cpus','1',
      '--tmpfs','/tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000','--mount',`type=volume,src=${volume},dst=/workspace`,...proxyEnv,
      ...(source?['--mount',`type=bind,src=${source.bundle},dst=/bootstrap/source.bundle,readonly`]:[]),image,'node','/opt/l4/operate.mjs']
    const payload={request:job.request,baseSha:job.baseSha}
    const result=await runProcess('docker',args,{input:JSON.stringify(payload),signal:controller.signal,timeoutMs:Math.min(150000,(job.request.timeoutMs||120000)+10000),limit:400000})
    if(result.code!==0)throw new Error('Workspace container failed')
    const output=JSON.parse(result.stdout.toString())
    await workspaceDisks.command('sync',['--file-system',mountPath])
    // Preserve exact command receipts outside the workspace. The Agent cannot edit these files.
    return {...output,runtimeMs:Date.now()-started}
  } finally { controller.signal.removeEventListener('abort',stop);await cleanup() }
}
// Re-submit only retained receipts. Never restart a command after process loss.
for (const saved of store.receipts()) {
  try { await poll(saved); store.acknowledge(saved.id,saved.lease) }
  catch { console.warn('compute.retained_receipt_requires_review') }
}
let stopping=false,active
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;active?.abort()})
while(!stopping){
  try {
    const {job:claim}=await poll({operation:'claim'})
    if(!claim){await delay(1000);continue}
    if(!/^[a-f0-9-]{36}$/u.test(claim.id)||!/^[a-f0-9]{64}$/u.test(claim.lease))throw new Error('Invalid Node job lease')
    const controller=new AbortController();active=controller
    const heartbeat=setInterval(()=>{void poll({operation:'heartbeat',...claim}).catch(()=>controller.abort())},3000)
    const start=Date.now()
    let result
    try { const job=await poll({operation:'begin',...claim});job.id=claim.id;const limit=setTimeout(()=>controller.abort(),job.executionBudgetMs);try{result=await execute(job,controller)}finally{clearTimeout(limit);await revokeSource(job)} }
    catch(error) { result={ok:false,exitCode:-1,output:controller.signal.aborted?'Operation stopped after revocation, disconnect or expired lease':error instanceof Error && error.message==='Compute Node disk is full; free space or move Task storage to a larger disk'?error.message:'Compute operation failed; inspect limits, source access and Node availability',runtimeMs:Math.min(180000,Date.now()-start)} }
    finally {clearInterval(heartbeat);active=undefined}
    const receipt={operation:'result',...claim,result}
    // FULL-synchronous transaction commits before the network callback. If the
    // journal is unavailable/full, stop; never lose a receipt and continue work.
    try { store.retain(receipt) } catch { console.error('compute.receipt_storage_unavailable');stopping=true;continue }
    try {await poll(receipt);store.acknowledge(claim.id,claim.lease)}catch{console.warn('compute.receipt_requires_review',{actionId:claim.id})}
  }catch(error){active?.abort();if(error.status===403){console.warn('compute.connection_revoked');break}await delay(3000)}
}
store.close()

import { LoopDiskStore } from './disk-store.mjs'
import { join, resolve } from 'node:path'
import { runProcess } from './process.mjs'
import { openNodeState, serverOrigin } from './state-store.mjs'
import { statfs, mkdir, chmod, writeFile, rename, rm } from 'node:fs/promises'
import { nodeCapacity } from './capacity.mjs'
import { createBoxHost } from './boxes.mjs'

const state = resolve(process.env.LLLL_NODE_STATE || './compute-node-state')
const image = process.env.LLLL_WORKSPACE_IMAGE
const configuredDiskBytes = Number(process.env.LLLL_WORKSPACE_DISK_BYTES || 10737418240)
if (![1073741824, 10737418240].includes(configuredDiskBytes)) throw new Error('LLLL_WORKSPACE_DISK_BYTES must be 1073741824 or 10737418240')
if (!/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/u.test(image ?? '')) throw new Error('Set LLLL_WORKSPACE_IMAGE to an immutable registry digest')
if (process.env.LLLL_SHARED_KERNEL_TRUSTED !== '1') throw new Error('Docker shares the host kernel. Confirm trusted-code use with LLLL_SHARED_KERNEL_TRUSTED=1; public untrusted tenants require a stronger provider')
process.umask(0o077)
const server = serverOrigin(process.env.LLLL_SERVER_ORIGIN)
const store = await openNodeState(state)
// One hard-quota disk per box, kept while its Task is open; a box stops when idle, its disk does not go.
const boxDiskRoot = join(state,'box-disks'), diskSizes = [1073741824, 10737418240]
const boxDisks = bytes => new LoopDiskStore(boxDiskRoot,{bytes,maxDisks:64})
const sourceDisks = new LoopDiskStore(join(state,'source-disks'),{bytes:536870912,maxDisks:1})
// One commit copy at a time, for a review or a push; it never outlives its publication.
const publishDisks = new LoopDiskStore(join(state,'publish-disks'),{bytes:2147483648,maxDisks:1})
await boxDisks(configuredDiskBytes).initialize(); await sourceDisks.initialize(); await publishDisks.initialize()
const probe = new LoopDiskStore(join(state,'probe-disks'),{bytes:33554432,maxDisks:1})
await probe.initialize()
const probeId = crypto.randomUUID()
try { await probe.cleanup(); await probe.ensure(probeId,true) } finally { await probe.remove(probeId) }
// The Server places boxes within this capacity; a Node no longer runs one operation at a time.
const capabilities = { diskBytes:configuredDiskBytes,docker:true,durableDisk:true,isolation:'shared-kernel',image,capacity:nodeCapacity(),protocol:2 }
const docker = async (args,options={}) => {
  const result = await runProcess('docker',args,options)
  // A helper that failed still answers on stdout; its stderr, which could hold anything, stays here.
  if (result.code !== 0) throw Object.assign(new Error('Docker operation failed'),{output:result.stdout.toString()})
  return result.stdout.toString()
}
async function request(server,path,body,token,limit=420000) {
  const response = await fetch(server+path,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)})
  if (!response.ok) throw Object.assign(new Error('Server rejected Node operation'),{status:response.status})
  const chunks=[];let bytes=0
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>limit)throw new Error('Server response limit reached');chunks.push(chunk)}
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
// A turn's submission carries the conversation so far, up to 2 MB.
const poll=body=>request(server,'/api/compute-agent/poll',body,connection.token,body.operation==='turn'?2600000:420000)
await docker(['info','--format','{{.ServerVersion}}'])
await docker(['image','inspect',image])
// Only this paired Node's containers and networks. A restart never resumes an uncertain turn: the box
// starts again on the Server's word, and a turn it had begun ends with an error instead of running twice.
const owned=['--filter',`label=l4.node=${connection.nodeId}`,'--filter',`label=l4.server=${connection.serverId}`]
const leftovers=(await docker(['ps','-aq',...owned])).trim().split('\n').filter(Boolean)
for (const id of leftovers) await docker(['rm','-f',id])
for (const id of (await docker(['network','ls','-q',...owned])).trim().split('\n').filter(Boolean)) await docker(['network','rm',id]).catch(()=>{})
await sourceDisks.cleanup(); await publishDisks.cleanup()

async function revokeToken(token) {
  try { await fetch('https://api.github.com/installation/token',{method:'DELETE',redirect:'manual',headers:{Authorization:`Bearer ${token}`,'User-Agent':'L4-node'},signal:AbortSignal.timeout(10000)}) } catch { /* An expiring single-repository grant is never reused. */ }
}
async function revokeSource(job) {
  if(typeof job.sourceToken!=='string')return
  const token=job.sourceToken;delete job.sourceToken
  await revokeToken(token)
}
/** A push's review goes to the Server, which keeps it in R2. */
async function upload(approvalId,body) {
  const response=await fetch(`${server}/api/compute-agent/review/${approvalId}`,{method:'PUT',redirect:'manual',headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection.token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)})
  await response.body?.cancel()
  if(!response.ok)throw Object.assign(new Error('Server rejected the review'),{status:response.status})
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
// The source disk holds one bundle at a time, until the box's checkout has read it.
let sourceLock=Promise.resolve()
async function fetchSource(grant) {
  const previous=sourceLock;let unlock;sourceLock=new Promise(resolveLock=>{unlock=resolveLock})
  await previous
  try {
    const fetched=await sourceBundle(grant)
    return {bundle:fetched.bundle,release:async()=>{try{await sourceDisks.remove(fetched.diskId)}finally{unlock()}}}
  } catch(error) { unlock(); throw error }
}
const disks={
  ensure:(id,create,bytes)=>{if(!diskSizes.includes(bytes))throw new Error('Unsupported box disk policy');return boxDisks(bytes).ensure(id,create)},
  remove:id=>boxDisks(configuredDiskBytes).remove(id),
  flush:path=>boxDisks(configuredDiskBytes).command('sync',['--file-system',path]),
}
const diskFree=async()=>{const stats=await statfs(state);return Math.floor(Number(stats.bavail)*Number(stats.bsize))}
const scratch={ensure:id=>publishDisks.ensure(id,true),remove:id=>publishDisks.remove(id)}
// Each box's egress policy, read-only in its proxy, and its authority's certificate, read-only in the box.
// Neither holds a secret: the values and the authority's key reach the proxy only by docker exec.
const egressRoot=join(state,'box-egress')
const egressDirectory=id=>{if(!/^[a-f0-9-]{36}$/u.test(id))throw new Error('Invalid box');return join(egressRoot,id)}
async function publicFile(path,content){const temporary=`${path}.${crypto.randomUUID()}`;await writeFile(temporary,content,{mode:0o644});await chmod(temporary,0o644);await rename(temporary,path)}
const egressFiles={
  async prepare(id){const base=egressDirectory(id),files={policy:join(base,'policy'),ca:join(base,'ca')};for(const path of [base,files.policy,files.ca]){await mkdir(path,{recursive:true});await chmod(path,0o755)}return files},
  writePolicy:(id,policy)=>publicFile(join(egressDirectory(id),'policy','policy.json'),JSON.stringify(policy)),
  async writeCa(id,cert,bundle){await publicFile(join(egressDirectory(id),'ca','ca.pem'),cert);await publicFile(join(egressDirectory(id),'ca','bundle.pem'),bundle)},
  remove:id=>rm(egressDirectory(id),{recursive:true,force:true}),
}
const host=createBoxHost({docker,poll,disks,fetchSource,records:store.boxes,connection,image,server,capacity:capabilities.capacity,diskFree,scratch,upload,egressFiles,revoke:revokeToken,
  log:(event,detail)=>console.warn(event,detail)})
// A box disk without a record, from a lost state file, is reported until the Server says what it is.
for (const name of (await docker(['volume','ls','-q',...owned])).trim().split('\n').filter(Boolean)) {
  const match=/^l4-disk-([a-f0-9-]{36})$/u.exec(name)
  if (!match) continue
  try { host.adopt(match[1],JSON.parse(await docker(['volume','inspect',name]))[0]?.Labels?.['l4.task']) } catch { /* Not a box disk. */ }
}
let stopping=false,wake
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;wake?.()})
// Each sync renews every box's lease for a minute; the Server hands out turns in its answers.
while(!stopping){
  try { await host.sync() }
  catch(error) { if(error.status===403){console.warn('compute.connection_revoked');break} }
  await new Promise(resolveWait=>{wake=resolveWait;setTimeout(resolveWait,2000)})
}
await host.shutdown()
store.close()

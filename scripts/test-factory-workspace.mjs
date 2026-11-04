import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../packages/compute-node/src/process.mjs'

const suffix=randomUUID().slice(0,8),directory=await mkdtemp(join(tmpdir(),'l4-factory-docker-'))
const image=process.env.LLLL_FACTORY_TEST_IMAGE||'l4-workspace:test',volumes=[`l4-test-${suffix}-a`,`l4-test-${suffix}-b`]
const docker=async(args,options={})=>{const result=await runProcess('docker',args,options);assert.equal(result.code,0,result.stderr.toString());return result.stdout.toString()}
const git=async(...args)=>{const result=await runProcess('git',args,{cwd:directory});assert.equal(result.code,0);return result.stdout.toString().trim()}
let base
async function operation(volume,request){
  const result=await docker(['run','--rm','-i','--name',`l4-test-${suffix}`,'--network','none','--dns','127.0.0.1','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','1g','--cpus','1',
    '--tmpfs','/tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000','--mount',`type=volume,src=${volume},dst=/workspace`,
    ...(request.operation==='bootstrap'?['--mount',`type=bind,src=${join(directory,'source.bundle')},dst=/bootstrap/source.bundle,readonly`]:[]),
    '--env','HTTP_PROXY=','--env','HTTPS_PROXY=','--env','ALL_PROXY=','--env','http_proxy=','--env','https_proxy=',image],
    {input:JSON.stringify({request,baseSha:base}),timeoutMs:150000,limit:400000})
  return JSON.parse(result)
}
try{
  await git('init');await git('config','user.name','Existing Author');await git('config','user.email','existing@example.invalid')
  await writeFile(join(directory,'answer.mjs'),'export const answer = 1\n');await git('add','.');await git('commit','-m','Existing canonical history');base=await git('rev-parse','HEAD')
  await git('bundle','create','source.bundle','--all')
  for(const volume of volumes){await docker(['volume','create','--label','l4.test=factory',volume]);assert.equal((await operation(volume,{operation:'bootstrap'})).ok,true)}
  assert.equal((await operation(volumes[0],{operation:'write',path:'answer.mjs',content:'export const answer = 42\n'})).ok,true)
  const failed=await operation(volumes[0],{operation:'exec',command:"node -e 'process.exit(1)'",timeoutMs:1000});assert.equal(failed.exitCode,1)
  const commit=await operation(volumes[0],{operation:'exec',command:'git add answer.mjs && git commit -m "Reviewed change" && git log --oneline',timeoutMs:5000})
  assert.equal(commit.ok,true);assert.ok(commit.output.includes('Existing canonical history'))
  const before=await operation(volumes[0],{operation:'snapshot'});assert.equal(before.ok,true);assert.equal(before.snapshot.baseSha,base);assert.equal(before.snapshot.files[0].content,'export const answer = 42\n')
  // Each operation has a fresh container. Stopping compute retains only this Task's disk.
  await operation(volumes[0],{operation:'suspend'})
  const restored=await operation(volumes[0],{operation:'snapshot'});assert.equal(restored.snapshot.headSha,before.snapshot.headSha)
  const other=await operation(volumes[1],{operation:'read',path:'answer.mjs'});assert.equal(other.output,'export const answer = 1\n')
  const denied=await operation(volumes[0],{operation:'read',path:'../../etc/passwd'});assert.equal(denied.ok,false)
  const isolation=await operation(volumes[0],{operation:'exec',command:`node -e 'const fs=require("node:fs");console.log(JSON.stringify({uid:process.getuid(),docker:fs.existsSync("/var/run/docker.sock"),token:process.env.GITHUB_TOKEN||process.env.LLLL_RUNNER_TOKEN||null}));fetch("https://1.1.1.1",{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(5)).catch(()=>console.log("egress denied"))'`,timeoutMs:5000})
  assert.equal(isolation.ok,true);assert.ok(isolation.output.includes('"uid":1000'));assert.ok(isolation.output.includes('"docker":false'));assert.ok(isolation.output.includes('"token":null'));assert.ok(isolation.output.includes('egress denied'))
  console.log('PASS: real Docker persistent Git checkout, exact local commit snapshot, failure evidence, stop/resume, Task disk isolation, non-root execution, no Docker socket/credentials and public-egress denial')
}finally{await docker(['rm','-f',`l4-test-${suffix}`]).catch(()=>{});for(const volume of volumes)await docker(['volume','rm',volume]).catch(()=>{});await rm(directory,{recursive:true,force:true})}

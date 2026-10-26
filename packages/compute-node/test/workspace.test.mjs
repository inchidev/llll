import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,mkdir,symlink,rm,readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operate,snapshot,runProcess,safePath } from '../src/operate.mjs'
import { destination,publicIPv4 } from '../src/proxy.mjs'

test('persistent checkout supports normal commits, exact snapshots and bounded failed-test repair',async()=>{
  const root=await mkdtemp(join(tmpdir(),'l4-factory-'))
  const git=async(...args)=>{const result=await runProcess('git',args,{cwd:root});assert.equal(result.code,0);return result.stdout.toString().trim()}
  try{
    await git('init');await git('config','user.name','L4 Agent');await git('config','user.email','agent@local.invalid')
    await writeFile(join(root,'answer.mjs'),'export const answer = 1\n');await git('add','.');await git('commit','-m','Existing source history');const base=await git('rev-parse','HEAD')
    const write=await operate({request:{operation:'write',path:'answer.mjs',content:'export const answer = 2\n'}},root);assert.equal(write.ok,true)
    assert.equal((await operate({request:{operation:'exec',command:"node -e 'process.exit(1)'",timeoutMs:1000}},root)).exitCode,1)
    await git('add','.');await git('commit','-m','Fix answer')
    const first=await snapshot(root,base)
    assert.equal(first.headSha,await git('rev-parse','HEAD'));assert.equal(first.commits[0].message,'Fix answer\n');assert.equal(first.files[0].content,'export const answer = 2\n')
    assert.equal((await operate({request:{operation:'read',path:'answer.mjs'}},root)).output,'export const answer = 2\n')
    await operate({request:{operation:'write',path:'answer.mjs',content:'export const answer = 42\n'}},root)
    await assert.rejects(snapshot(root,base),/Commit all/u)
    await git('add','.');await git('commit','-m','Repair CI failure')
    const repaired=await snapshot(root,base);assert.equal(repaired.commits.length,2);assert.equal(repaired.commits[1].parents[0],first.headSha)
    assert.equal((await operate({request:{operation:'exec',command:"node -e 'process.exit(0)'",timeoutMs:1000}},root)).ok,true)
    assert.ok((await git('log','--oneline')).includes('Existing source history'))
  }finally{await rm(root,{recursive:true,force:true})}
})
test('file operations reject traversal, protected paths and symlink escapes',async()=>{
  for(const path of ['../other-task','/etc/passwd','.git/config','.github/workflows/push.yml','a/../../secret','a\\b','bad\nfile'])assert.equal(safePath(path),false)
  const root=await mkdtemp(join(tmpdir(),'l4-path-'))
  try{await symlink(tmpdir(),join(root,'escape'));await assert.rejects(operate({request:{operation:'write',path:'escape/stolen',content:'x'}},root));await mkdir(join(root,'src'));await operate({request:{operation:'write',path:'src/file',content:'ok'}},root);assert.equal(await readFile(join(root,'src/file'),'utf8'),'ok')}
  finally{await rm(root,{recursive:true,force:true})}
})
test('egress proxy denies private, rebinding, unselected and numeric destinations',async()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.17.0.1','192.168.0.1','100.100.100.100','0.0.0.0','::1','224.0.0.1'])assert.equal(publicIPv4(ip),false)
  await assert.rejects(destination('attacker.example',['registry.npmjs.org']))
  await assert.rejects(destination('registry.npmjs.org',['registry.npmjs.org'],async()=>[{address:'127.0.0.1'}]))
  await assert.rejects(destination('registry.npmjs.org',['registry.npmjs.org'],async()=>[{address:'1.1.1.1'},{address:'10.0.0.1'}]))
  assert.equal(await destination('registry.npmjs.org',['registry.npmjs.org'],async()=>[{address:'1.1.1.1'}]),'1.1.1.1')
})

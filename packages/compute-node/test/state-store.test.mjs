import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openNodeState, serverOrigin } from '../src/state-store.mjs'
import { runProcess } from '../src/process.mjs'

test('Node journal binds one validated connection to the configured Server and survives restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'l4-state-'))
  const connection={nodeId:randomUUID(),serverId:randomUUID(),token:'a'.repeat(64)}
  let store
  try {
    store=await openNodeState(directory)
    assert.equal(store.connection('https://server.example'),null)
    for(const value of [{...connection,token:'bad'}, {...connection,nodeId:'../escape'}])assert.throws(()=>store.pair('https://server.example',value))
    store.pair('https://server.example',connection)
    assert.throws(()=>store.pair('https://server.example',connection))
    assert.throws(()=>store.connection('https://other.example'),/different Server/u)
    store.close();store=await openNodeState(directory)
    assert.deepEqual(store.connection('https://server.example'),{server:'https://server.example',...connection})
    assert.equal((await stat(join(directory,'node-state.sqlite'))).mode & 0o777,0o600)
    assert.equal((await stat(directory)).mode & 0o777,0o700)
  } finally {store?.close();await rm(directory,{recursive:true,force:true})}
})
test('receipts persist exactly once, preserve evidence, reject changed identity and acknowledge only the exact lease',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'l4-receipts-'))
  const receipt={operation:'result',id:randomUUID(),lease:'b'.repeat(64),result:{ok:false,exitCode:1,output:'test failed; ; $(not a command)',runtimeMs:1000}}
  let store
  try {
    store=await openNodeState(directory);store.retain(receipt);store.retain(receipt)
    assert.throws(()=>store.retain({...receipt,lease:'c'.repeat(64)}),/identity/u)
    assert.throws(()=>store.retain({...receipt,result:{...receipt.result,output:'changed'}}),/identity/u)
    assert.throws(()=>store.retain({...receipt,id:'../../escape'}))
    assert.throws(()=>store.retain({...receipt,id:randomUUID(),result:{...receipt.result,output:'x'.repeat(64001)}}))
    store.close();store=await openNodeState(directory)
    assert.deepEqual(store.receipts(),[receipt])
    store.acknowledge(receipt.id,'c'.repeat(64));assert.equal(store.receipts().length,1)
    store.acknowledge(receipt.id,receipt.lease);assert.deepEqual(store.receipts(),[])
    for(let i=0;i<128;i++)store.retain({...receipt,id:randomUUID()})
    assert.throws(()=>store.retain({...receipt,id:randomUUID()}),/capacity/u)
    assert.equal(store.receipts().length,128)
  } finally {store?.close();await rm(directory,{recursive:true,force:true})}
})
test('Node state rejects symlinks and requires a safe explicit Server origin',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'l4-state-path-'))
  try {
    await writeFile(join(directory,'elsewhere'),'private')
    await symlink(join(directory,'elsewhere'),join(directory,'node-state.sqlite'))
    await assert.rejects(openNodeState(directory),/Unsafe/u)
    for(const value of ['http://remote.example','https://user:pass@server.example','https://server.example/other','https://server.example?x=1'])assert.throws(()=>serverOrigin(value))
    assert.equal(serverOrigin('http://127.0.0.1:3000'),'http://127.0.0.1:3000')
  } finally {await rm(directory,{recursive:true,force:true})}
})
test('host process launcher never exposes a shell or arbitrary executable',async()=>{
  for(const tool of ['/bin/sh','sh','bash','node','__proto__','/tmp/docker'])await assert.rejects(runProcess(tool,['-c','exit 0']),/Unsupported/u)
  await assert.rejects(runProcess('git',['--version\0']),/Unsupported/u)
  assert.equal((await runProcess('git',['--version'])).code,0)
})

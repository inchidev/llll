import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,lstat,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoopDiskStore } from '../src/disk-store.mjs'

test('reports storage exhaustion without exposing a raw host path',async()=>{
  const store=new LoopDiskStore('/tmp/l4-test',{runner:async()=>({code:1,stdout:Buffer.alloc(0),stderr:Buffer.from('fallocate: /private/path: No space left on device')})})
  await assert.rejects(store.command('fallocate',[]),error=>/disk is full/u.test(error.message)&&!error.message.includes('/private/path'))
})

test('hard disk provider allocates bounded files once, validates mounts and scopes cleanup',async()=>{
  const root=await mkdtemp(join(tmpdir(),'l4-disk-store-')),commands=[]
  let mounted=false,foreign=false
  const runner=async(name,args)=>{
    commands.push({name,args})
    if(name==='fallocate')await writeFile(args.at(-1),Buffer.alloc(4096))
    if(name==='mount')mounted=true
    if(name==='umount')mounted=false
    const stdout=name==='findmnt'&&mounted?foreign?'/dev/foreign':'/dev/loop-test':name==='losetup'?'/dev/loop-test':''
    return {code:name==='findmnt'&&!mounted?1:0,stdout:Buffer.from(stdout),stderr:Buffer.alloc(0)}
  }
  const store=new LoopDiskStore(root,{bytes:4096,maxDisks:1,runner,ownerUid:process.getuid(),ownerGid:process.getgid()})
  const id='00000000-0000-4000-8000-000000000001'
  try{
    const mount=await store.ensure(id,true);assert.equal(mount,join(root,id));assert.equal((await lstat(join(root,id+'.img'))).size,4096)
    await store.ensure(id,false);assert.equal(commands.filter(call=>call.name==='fallocate').length,1)
    assert.deepEqual(commands.find(call=>call.name==='mount').args,['-o','loop,nodev,nosuid',join(root,id+'.img'),join(root,id)])
    await assert.rejects(store.ensure('00000000-0000-4000-8000-000000000002',true),/capacity/u)
    await assert.rejects(store.ensure('../../foreign',true),/identity/u)
    foreign=true;await assert.rejects(store.remove(id),/Foreign filesystem/u)
    assert.ok((await lstat(join(root,id+'.img'))).isFile())
    foreign=false;await store.remove(id);await assert.rejects(lstat(join(root,id+'.img')),{code:'ENOENT'})
  }finally{await rm(root,{recursive:true,force:true})}
})

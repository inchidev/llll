import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createLizardRelay} from '../src/lizard-relay.mjs'
const secret='a'.repeat(64)
test('only the broker capability receives compute requests and resolves them once',async()=>{
 const server=createLizardRelay(secret,{timeoutMs:2000});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url='http://127.0.0.1:'+server.address().port
 try {
  assert.equal((await fetch(url+'/bridge/next')).status,403)
  assert.equal((await fetch(url+'/other',{method:'POST'})).status,404)
  const pending=fetch(url+'/api/compute-agent/poll',{method:'POST',headers:{authorization:'Bearer node-token'},body:'{"operation":"claim"}'})
  let job
  for(let n=0;n<30&&!job;n++){job=await(await fetch(url+'/bridge/next',{headers:{'x-relay-key':secret}})).json();if(!job)await new Promise(resolve=>setTimeout(resolve,10))}
  assert.equal(job.path,'/api/compute-agent/poll');assert.equal(job.authorization,'Bearer node-token')
  const reply={id:job.id,status:200,body:'{"job":null}'}
  assert.equal((await fetch(url+'/bridge/respond',{method:'POST',headers:{'x-relay-key':secret},body:JSON.stringify(reply)})).status,204)
  assert.deepEqual(await(await pending).json(),{job:null})
  assert.equal((await fetch(url+'/bridge/respond',{method:'POST',headers:{'x-relay-key':secret},body:JSON.stringify(reply)})).status,404)
 }finally{await new Promise(resolve=>server.close(resolve))}
})

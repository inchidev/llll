import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destination,publicIPv4 } from '../src/proxy.mjs'

test('egress proxy denies private, rebinding, unselected and numeric destinations',async()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.17.0.1','192.168.0.1','100.100.100.100','0.0.0.0','::1','224.0.0.1'])assert.equal(publicIPv4(ip),false)
  await assert.rejects(destination('attacker.example',['registry.npmjs.org']))
  await assert.rejects(destination('registry.npmjs.org',['registry.npmjs.org'],async()=>[{address:'127.0.0.1'}]))
  await assert.rejects(destination('registry.npmjs.org',['registry.npmjs.org'],async()=>[{address:'1.1.1.1'},{address:'10.0.0.1'}]))
  assert.equal(await destination('registry.npmjs.org',['registry.npmjs.org'],async()=>[{address:'1.1.1.1'}]),'1.1.1.1')
})

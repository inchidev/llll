import assert from 'node:assert/strict'

export async function testFactoryTransport({api}) {
  const root='/api/compute-nodes',capabilities={diskBytes:1073741824,docker:true,durableDisk:true,isolation:'shared-kernel',image:'registry.example/l4@sha256:'+'a'.repeat(64),maxParallel:1,protocol:1}
  await api('alpha',root,{actor:'anonymous',expected:401})
  await api('alpha',root,{actor:'alpha-member',expected:403})
  await api('alpha',root,{actor:'alpha-member',method:'POST',body:{name:'Unauthorized'},expected:403})
  await api('alpha',root,{method:'POST',body:{name:'Wrong',command:'docker run --privileged'},expected:400})
  const pairing=(await api('alpha',root,{method:'POST',body:{name:'Factory HTTP Node'}})).payload
  assert.match(pairing.token,/^[a-f0-9]{64}$/u)
  await api('alpha','/api/compute-agent/pair',{actor:'anonymous',method:'POST',body:{token:pairing.token,capabilities},headers:{Origin:'https://attacker.example'},expected:403})
  const paired=(await api('alpha','/api/compute-agent/pair',{actor:'anonymous',method:'POST',body:{token:pairing.token,capabilities}})).payload
  assert.match(paired.token,/^[a-f0-9]{64}$/u)
  await api('alpha','/api/compute-agent/pair',{actor:'anonymous',method:'POST',body:{token:pairing.token,capabilities},expected:403})
  const headers={Authorization:'Bearer '+paired.token}
  assert.equal((await api('alpha','/api/compute-agent/poll',{actor:'anonymous',method:'POST',headers,body:{operation:'claim'}})).payload.job,null)
  await api('alpha','/api/compute-agent/poll',{actor:'anonymous',method:'POST',headers,body:{operation:'exec',command:'forged host command'},expected:400})
  await api('beta','/api/compute-agent/poll',{actor:'anonymous',method:'POST',headers,body:{operation:'claim'},expected:403})
  const listed=(await api('alpha',root)).payload
  assert.ok(listed.nodes.some(node=>node.id===paired.nodeId&&node.enabled))
  assert.equal(JSON.stringify(listed).includes(paired.token),false)
  assert.equal(JSON.stringify(listed).includes('token_hash'),false)
  assert.equal((await api('beta',root)).payload.nodes.length,0)
  await api('alpha',root+'/'+paired.nodeId,{actor:'alpha-member',method:'DELETE',expected:403})
  await api('alpha',root+'/'+paired.nodeId,{method:'DELETE'})
  await api('alpha','/api/compute-agent/poll',{actor:'anonymous',method:'POST',headers,body:{operation:'claim'},expected:403})
  console.log('PASS: real Worker compute pairing HTTP, Owner-only setup, one-use state, Node bearer transport, forged-operation denial, cross-Server isolation, private credentials and revocation')
}

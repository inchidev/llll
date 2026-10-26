import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { importSPKI, jwtVerify } from 'jose'
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),pem=pair.privateKey.export({type:'pkcs1',format:'pem'}).toString()
const publicKey=await importSPKI(pair.publicKey.export({type:'spki',format:'pem'}).toString(),'RS256')
let seq=0
const capabilities=new Map()
export async function githubSetupFixture(request){
 const url=new URL(request.url)
 if(url.origin!=='https://api.github.com')return null
 if(url.pathname==='/app-manifests/test-code/conversions'){
  assert.equal(request.method,'POST');assert.equal(request.headers.has('Authorization'),false)
  return Response.json({id:4242,slug:'l4-http-fixture',pem,owner:{login:'inchidev'},client_secret:'discard-this',webhook_secret:'discard-this'})
 }
 const paths=['/app/installations','/app/installations/7/access_tokens','/installation/repositories','/installation/token','/repos/inchidev/afterprompt','/repos/inchidev/afterprompt/commits/main']
 if(!paths.includes(url.pathname))return null
 const token=request.headers.get('Authorization')?.slice(7)
 if(url.pathname.startsWith('/app/')){
  await jwtVerify(token,publicKey,{issuer:'4242',algorithms:['RS256']})
  if(url.pathname==='/app/installations')return Response.json([{id:7,suspended_at:null}])
  const body=await request.json(),cap='git-http-cap-'+(++seq)
  assert.ok(body.permissions.metadata==='read'||body.permissions.contents==='read')
  capabilities.set(cap,body);return Response.json({token:cap})
 }
 const cap=capabilities.get(token);assert.ok(cap)
 if(url.pathname==='/installation/token'){capabilities.delete(token);return new Response(null,{status:204})}
 if(url.pathname==='/installation/repositories'){
  assert.equal(cap.permissions.metadata,'read')
  return Response.json({repositories:[{id:1380041578,full_name:'inchidev/afterprompt',archived:false,fork:false,default_branch:'main'}]})
 }
 assert.deepEqual(cap.repository_ids,[1380041578]);assert.equal(cap.permissions.contents,'read')
 if(url.pathname.endsWith('/commits/main'))return Response.json({sha:'a'.repeat(40),commit:{tree:{sha:'b'.repeat(40)}}})
 return Response.json({id:1380041578,full_name:'inchidev/afterprompt',archived:false,fork:false,default_branch:'main'})
}
export async function testGitConnections({api,runtimes,ids}){
 const root='/api/git-connections',db=await runtimes.alpha.getD1Database('DB')
 await api('alpha',root,{actor:'anonymous',expected:401})
 await api('alpha',root,{actor:'alpha-member',expected:403})
 const input={name:'GitHub HTTP fixture',account:'inchidev',organization:true}
 await api('alpha',root+'/github/manifest',{actor:'alpha-member',method:'POST',body:input,expected:403})
 await api('alpha',root+'/github/manifest',{method:'POST',body:input,headers:{Origin:'https://attacker.example'},expected:403})
 const prepared=(await api('alpha',root+'/github/manifest',{method:'POST',body:input})).payload
 assert.equal(prepared.manifest.public,false);assert.equal(prepared.manifest.default_permissions.contents,'write')
 const state=new URL(prepared.actionUrl).searchParams.get('state'),callback=root+'/github/callback?code=test-code&state='+state
 const signIn=await api('alpha',callback,{actor:'anonymous',expected:302,redirect:'manual'})
 assert.equal(signIn.response.headers.get('Location'),'/git-connections/github/complete?code=test-code&state='+state)
 await api('alpha',callback,{actor:'alpha-member',expected:403})
 await api('beta',callback,{expected:409})
 const done=await api('alpha',callback,{expected:302,redirect:'manual'})
 assert.equal(done.response.headers.get('Referrer-Policy'),'no-referrer')
 assert.equal(done.response.headers.get('Location'),`/server/${ids.alpha}/settings?section=environments`)
 await api('alpha',callback,{expected:409})
 const listed=(await api('alpha',root)).payload,connection=listed.connections.find(c=>c.name===input.name)
 assert.ok(connection);assert.equal(JSON.stringify(listed).includes('PRIVATE KEY'),false)
 const stored=(await db.prepare('SELECT credential_json AS credential FROM git_connections WHERE id=?').bind(connection.id).first()).credential
 assert.ok(stored&&!stored.includes('PRIVATE KEY')&&!stored.includes('discard-this'))
 const repos=(await api('alpha','/api/code-environments/repositories?connectionId='+connection.id)).payload.repositories
 assert.equal(repos[0].name,'inchidev/afterprompt')
 const environment=(await api('alpha','/api/code-environments',{method:'POST',body:{name:'Connected afterprompt',gitConnectionId:connection.id,sourceRepo:repos[0].name,sourceRepoId:repos[0].id,sourceInstallationId:repos[0].installationId,workRepo:repos[0].name,workRepoId:repos[0].id,workInstallationId:repos[0].installationId,baseBranch:'main',requiredChecks:['test'],previewHosts:[]}})).payload.environment
 assert.equal(environment.workRepoId,environment.sourceRepoId)
 assert.equal(environment.gitConnectionId,connection.id)
 await api('alpha',root+'/'+connection.id,{actor:'alpha-member',method:'DELETE',expected:403})
 await api('alpha',root+'/'+connection.id,{method:'DELETE'})
 await api('alpha','/api/code-environments/repositories?connectionId='+connection.id,{expected:403})
 assert.equal((await api('alpha',root)).payload.connections.find(c=>c.id===connection.id).enabled,false)
 console.log('PASS: GitHub App manifest HTTP, Owner/state/origin enforcement, encrypted callback exchange, selected-App repository discovery, same-repository setup and revocation')
 return {connectionId:connection.id,credentialJson:stored}
}

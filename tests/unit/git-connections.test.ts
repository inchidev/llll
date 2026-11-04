import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { completeGithubSetup, disableGitConnection, githubConnectionCredentials, listGitConnections, prepareGithubSetup, reopenGithubSetup } from '../../server/utils/git-connections'
import { githubAgentClient } from '../../server/utils/github-agent-client'
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),pem=pair.privateKey.export({type:'pkcs1',format:'pem'}).toString()
let f:ReturnType<typeof mcpFixture>
beforeEach(()=>{f=mcpFixture();f.env.PUBLIC_ORIGIN='https://server.example.test'})
afterEach(()=>{f.db.close();vi.useRealTimers()})
const prepare=async()=>prepareGithubSetup(f.env,await f.actor(),{name:'L4 code',account:'inchidev',organization:true})
const state=(p:Awaited<ReturnType<typeof prepare>>)=>new URL(p.actionUrl).searchParams.get('state')!
const exchange=()=>vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
 expect(String(url)).toBe('https://api.github.com/app-manifests/test-code/conversions');expect(init?.redirect).toBe('manual')
 expect(new Headers(init?.headers).has('Authorization')).toBe(false)
 return Response.json({id:4242,slug:'l4-code',pem,owner:{login:'inchidev'},client_secret:'never-store-me',webhook_secret:'never-store-me'})
})
it('does not include an unreachable webhook in a localhost manifest',async()=>{
 f.env.PUBLIC_ORIGIN='http://localhost:3700'
 const p=await prepare()
 expect(p.manifest.redirect_url).toBe('http://localhost:3700/api/git-connections/github/callback')
 expect(p.manifest).not.toHaveProperty('hook_attributes')
})
it('allows only the same owner to resume a recent, unconsumed setup',async()=>{
 const p=await prepare(), token=state(p)
 f.db.prepare("UPDATE git_setup_requests SET expires_at='2000-01-01T00:00:00.000Z'").run()
 await expect(reopenGithubSetup(f.env,await f.actor(ids.member),token)).rejects.toMatchObject({statusCode:403})
 await reopenGithubSetup(f.env,await f.actor(),token)
 expect((await completeGithubSetup(f.env,await f.actor(),'test-code',token,exchange())).enabled).toBe(true)
 await expect(reopenGithubSetup(f.env,await f.actor(),token)).rejects.toMatchObject({statusCode:409})
})
it('prepares an Owner-bound, expiring manifest from the configured origin without credentials',async()=>{
 const p=await prepare()
 expect(p.actionUrl).toMatch(/^https:\/\/github.com\/organizations\/inchidev\/settings\/apps\/new\?state=[a-f0-9]{64}$/u)
 expect(p.manifest.redirect_url).toBe('https://server.example.test/api/git-connections/github/callback')
 expect(p.manifest.setup_url).toBe(`https://server.example.test/server/${(await f.actor()).serverId}/settings?section=environments`)
 expect(p.manifest.default_permissions).toMatchObject({contents:'write',pull_requests:'write',checks:'read'})
 expect(JSON.stringify(p)).not.toMatch(/private.key|AUTH_SECRET/iu)
 const row=f.db.prepare('SELECT state_hash AS hash,status FROM git_setup_requests').get()!
 expect(row.hash).not.toBe(state(p));expect(row.status).toBe('pending')
 expect(await listGitConnections(f.env)).toEqual([])
})
it('prepares a personal App without an account and stores the GitHub owner',async()=>{
 const p=await prepareGithubSetup(f.env,await f.actor(),{})
 expect(p.actionUrl).toMatch(/^https:\/\/github.com\/settings\/apps\/new\?state=[a-f0-9]{64}$/u)
 expect(p.manifest.name).toBe('L4 server.example.test')
 const remote=vi.fn(async()=>Response.json({id:4242,slug:'l4-code',name:'L4 code',pem,owner:{login:'someone',type:'User'}}))
 expect(await completeGithubSetup(f.env,await f.actor(),'test-code',state(p),remote)).toMatchObject({account:'someone',name:'L4 code'})
 const org=await prepareGithubSetup(f.env,await f.actor(),{})
 await expect(completeGithubSetup(f.env,await f.actor(),'test-code',state(org),vi.fn(async()=>Response.json({id:4243,slug:'l4-org',pem,owner:{login:'acme',type:'Organization'}})))).rejects.toMatchObject({statusCode:502})
 await expect(prepareGithubSetup(f.env,await f.actor(),{organization:true})).rejects.toThrow()
})
it('rejects non-Owner and delegated setup without exposing or exchanging credentials',async()=>{
 await expect(prepareGithubSetup(f.env,await f.actor(ids.member),{name:'Other',account:'inchidev'})).rejects.toMatchObject({statusCode:403})
 const owner=await f.actor()
 await expect(prepareGithubSetup(f.env,{...owner,delegation:{by:ids.owner,permissions:0}},{name:'Other',account:'inchidev'})).rejects.toMatchObject({statusCode:403})
 const p=await prepare(),remote=exchange()
 await expect(completeGithubSetup(f.env,await f.actor(ids.member),'test-code',state(p),remote)).rejects.toMatchObject({statusCode:403})
 expect(remote).not.toHaveBeenCalled()
})
it('validates origin/account, rejects credential-bearing origins and bounds pending requests',async()=>{
 const owner=await f.actor()
 for(const origin of ['', 'http://example.test','https://user:pass@example.test','https://example.test/other']){
  f.env.PUBLIC_ORIGIN=origin
  await expect(prepare()).rejects.toMatchObject({statusCode:409})
 }
 f.env.PUBLIC_ORIGIN='https://server.example.test'
 await expect(prepareGithubSetup(f.env,owner,{name:'Bad',account:'attacker/redirect'})).rejects.toThrow()
 for(let i=0;i<5;i++)await prepare()
 await expect(prepare()).rejects.toMatchObject({statusCode:429})
})
it('stores only encrypted App credentials and requires an explicit connection for broker use',async()=>{
 const p=await prepare(),remote=exchange(),connection=await completeGithubSetup(f.env,await f.actor(),'test-code',state(p),remote)
 expect(connection).toMatchObject({provider:'github',account:'inchidev',appId:'4242',setupUrl:'https://github.com/apps/l4-code/installations/new'})
 const stored=f.db.prepare('SELECT credential_json AS secret FROM git_connections WHERE id=?').get(connection.id)!.secret
 expect(String(stored)).not.toContain('PRIVATE KEY')
 expect(JSON.stringify(await listGitConnections(f.env))).not.toMatch(/PRIVATE KEY|never-store-me|ciphertext/u)
 expect(await githubConnectionCredentials(f.env)).toBeNull()
 expect(await githubConnectionCredentials(f.env,connection.id)).toEqual({appId:'4242',privateKey:pem})
 const provider=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
  expect(String(url)).toBe('https://api.github.com/app/installations/7/access_tokens')
  expect(JSON.parse(String(init?.body))).toEqual({repository_ids:[11],permissions:{contents:'read'}})
  return Response.json({token:'scoped-test-token'})
 })
 await githubAgentClient(f.env,{connectionId:connection.id,installationId:7,repositoryId:11,access:'read'},undefined,provider)
 expect(provider).toHaveBeenCalledTimes(1)
 expect(JSON.stringify(f.db.prepare('SELECT meta_json FROM audit_log').all())).not.toContain('PRIVATE KEY')
})
it('rejects replay, wrong state, expiry and changed configured origin before exchange',async()=>{
 const p=await prepare(),remote=exchange()
 await expect(completeGithubSetup(f.env,await f.actor(),'test-code','0'.repeat(64),remote)).rejects.toMatchObject({statusCode:409})
 f.env.PUBLIC_ORIGIN='invalid'
 await expect(completeGithubSetup(f.env,await f.actor(),'test-code',state(p),remote)).rejects.toMatchObject({statusCode:409})
 f.env.PUBLIC_ORIGIN='https://other.example.test'
 await expect(completeGithubSetup(f.env,await f.actor(),'test-code',state(p),remote)).rejects.toMatchObject({statusCode:409})
 f.env.PUBLIC_ORIGIN='https://server.example.test'
 await completeGithubSetup(f.env,await f.actor(),'test-code',state(p),remote)
 await expect(completeGithubSetup(f.env,await f.actor(),'test-code',state(p),remote)).rejects.toMatchObject({statusCode:409})
 expect(remote).toHaveBeenCalledTimes(1)
 const next=await prepare();vi.useFakeTimers();vi.setSystemTime(Date.now()+11*60000)
 await expect(completeGithubSetup(f.env,await f.actor(),'test-code',state(next),remote)).rejects.toMatchObject({statusCode:409})
 expect(remote).toHaveBeenCalledTimes(1)
})
it('does not follow redirects or retry uncertain exchanges and rejects unexpected App owners',async()=>{
 for(const mode of ['redirect','owner','timeout']){
  const p=await prepare(),remote=vi.fn(async()=>{
   if(mode==='timeout')throw Error('Network error containing a secret')
   if(mode==='redirect')return new Response(null,{status:302,headers:{Location:'https://attacker.example/'}})
   return Response.json({id:4242,slug:'l4-code',pem,owner:{login:'attacker'}})
  })
  await expect(completeGithubSetup(f.env,await f.actor(),'test-code',state(p),remote)).rejects.toMatchObject({statusCode:502})
  await expect(completeGithubSetup(f.env,await f.actor(),'test-code',state(p),remote)).rejects.toMatchObject({statusCode:409})
  expect(remote).toHaveBeenCalledTimes(1)
 }
 expect(await listGitConnections(f.env)).toEqual([])
})
it('revokes selected connections and never falls back to deployment credentials',async()=>{
 const p=await prepare(),connection=await completeGithubSetup(f.env,await f.actor(),'test-code',state(p),exchange())
 await expect(disableGitConnection(f.env,await f.actor(ids.member),connection.id)).rejects.toMatchObject({statusCode:403})
 await disableGitConnection(f.env,await f.actor(),connection.id)
 f.env.GITHUB_AGENT_APP_ID='legacy';f.env.GITHUB_AGENT_APP_PRIVATE_KEY=pem
 await expect(githubConnectionCredentials(f.env,connection.id)).rejects.toMatchObject({statusCode:403})
 expect((await listGitConnections(f.env))[0]!.enabled).toBe(false)
 const remote=vi.fn()
 await expect(githubAgentClient(f.env,{connectionId:connection.id,installationId:7,repositoryId:11,access:'read'},undefined,remote)).rejects.toMatchObject({statusCode:403})
 expect(remote).not.toHaveBeenCalled()
})

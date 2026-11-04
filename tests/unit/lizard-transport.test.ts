import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpFixture } from '../helpers/outbound-mcp'
import { saveLizardConnection } from '../../server/utils/lizard-connection'
import { execLizardBootstrap, exposeLizardBridge, writeLizardBootstrapFile } from '../../server/utils/lizard-transport'
let f: ReturnType<typeof mcpFixture>
beforeEach(async()=>{f=mcpFixture();vi.stubGlobal('fetch',vi.fn(async()=>Response.json([{id:'project-a',name:'A'}])));await saveLizardConnection(f.env,await f.actor(),'secret-key','project-a')})
afterEach(()=>{vi.unstubAllGlobals();f.db.close()})
it('sends bounded bootstrap operations through the selected provider',async()=>{
 const calls:{url:string;init?:RequestInit}[]=[]
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{calls.push({url,init});return url.endsWith('/exec')?Response.json({stdout:'ok',stderr:'',exitCode:0}):Response.json({status:'ok'})}))
 await writeLizardBootstrapFile(f.env,'test-vm','/workspace/l4/relay.mjs','content')
 expect(await execLizardBootstrap(f.env,'test-vm',['node','--version'],{timeoutMs:10000})).toMatchObject({stdout:'ok'})
 expect(calls.map(c=>c.url)).toEqual(['https://lizard.build/api/sandboxes/test-vm/files','https://lizard.build/api/sandboxes/test-vm/exec'])
 expect(JSON.stringify(calls.map(c=>c.url))).not.toContain('secret-key')
})
it('rejects invalid paths and untrusted bridge hostnames',async()=>{
 await expect(writeLizardBootstrapFile(f.env,'test-vm','/etc/shadow','x')).rejects.toThrow()
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({hostname:'attacker.example',accessToken:'a'.repeat(32)})))
 await expect(exposeLizardBridge(f.env,'test-vm')).rejects.toMatchObject({statusCode:503})
})

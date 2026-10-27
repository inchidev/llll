import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpFixture } from '../helpers/outbound-mcp'
import { prepareComputePairing, requireComputeNode } from '../../server/utils/compute-nodes'
import { serviceLizardBridge } from '../../server/utils/lizard-bridge'
let f: ReturnType<typeof mcpFixture>
const connection={hostname:'example.sandbox.us-east-1.onlizard.com',accessToken:'access-secret',relayKey:'a'.repeat(64)}
beforeEach(()=>{f=mcpFixture()})
afterEach(()=>{vi.unstubAllGlobals();f.db.close()})
it('pairs the Node through a narrowly scoped authenticated bridge',async()=>{
 const pairing=await prepareComputePairing(f.env,await f.actor(),'Lizard test')
 const job:{id:string;path:string;authorization:string|null;body:string}={id:'b5949476-1a4e-4141-bfc6-a72a7751fd95',path:'/api/compute-agent/pair',authorization:null,body:JSON.stringify({token:pairing.token,capabilities:{provider:'lizard',diskBytes:1073741824,docker:true,durableDisk:true,isolation:'shared-kernel',image:'sha256:'+'0'.repeat(64),maxParallel:1,protocol:1}})}
 const calls: {url:string,init?:RequestInit}[]=[]
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{calls.push({url,init});return calls.length===1?Response.json(job):new Response(null,{status:204})}))
 let persisted: string | undefined
 const result=await serviceLizardBridge(f.env,connection,undefined,async id=>{persisted=id})
 expect(result).toMatchObject({processed:true,nodeId:expect.any(String)})
 if (!result.processed || !result.nodeId) throw Error('Node was not paired')
 expect(persisted).toBe(result.nodeId)
 const response=JSON.parse(String(calls[1]!.init?.body))
 expect(response.status).toBe(200);expect(JSON.parse(response.body).nodeId).toBe(result.nodeId)
 expect(JSON.stringify(result)).not.toContain('access-secret')
 const credential=JSON.parse(response.body).token
 await expect(requireComputeNode(f.env,credential)).rejects.toMatchObject({statusCode:403})
 calls.length=0
 job.path='/api/compute-agent/poll';job.authorization='Bearer '+credential;job.body=JSON.stringify({operation:'claim'})
 await serviceLizardBridge(f.env,connection,'different-node')
 expect(JSON.parse(String(calls[1]!.init?.body)).status).toBe(403)
 calls.length=0
 await serviceLizardBridge(f.env,connection,result.nodeId)
 expect(JSON.parse(String(calls[1]!.init?.body)).status).toBe(200)
})
it('rejects foreign URLs and malformed broker messages',async()=>{
 await expect(serviceLizardBridge(f.env,{...connection,hostname:'127.0.0.1'})).rejects.toMatchObject({statusCode:400})
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:'not-a-uuid',path:'/anything',authorization:null,body:'{}'})))
 await expect(serviceLizardBridge(f.env,connection)).rejects.toMatchObject({statusCode:503})
})

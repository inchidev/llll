import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { saveLizardConnection } from '../../server/utils/lizard-connection'
import { ensureLizardCompute, startLizardCompute, stopLizardCompute } from '../../server/utils/lizard-control'
let f:ReturnType<typeof mcpFixture>
const controller={status:vi.fn(),start:vi.fn(),stop:vi.fn(),ensure:vi.fn()}
beforeEach(async()=>{
 f=mcpFixture();vi.clearAllMocks();vi.stubGlobal('fetch',vi.fn(async()=>Response.json([{id:'project-a',name:'A'}])))
 await saveLizardConnection(f.env,await f.actor(),'secret-key','project-a')
 f.env.LIZARD_COMPUTE_DO={getByName:()=>controller} as never
 controller.status.mockResolvedValue({phase:'stopped',workspaceId:null,nodeId:null,retainedStorage:false})
 controller.start.mockResolvedValue({phase:'volume'})
})
afterEach(()=>{vi.unstubAllGlobals();f.db.close()})
it('mints a one-use pairing and starts an owner-authorized Lizard node',async()=>{
 expect(await startLizardCompute(f.env,await f.actor())).toMatchObject({phase:'volume'})
 const [workspaceId,token]=controller.start.mock.calls[0]!
 expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/u);expect(token).toMatch(/^[0-9a-f]{64}$/u)
 const rows=f.db.prepare('SELECT name,token_hash FROM compute_pairings').all()
 expect(rows).toHaveLength(1);expect(rows[0]!.name).toBe('Lizard '+workspaceId);expect(rows[0]!.token_hash).not.toBe(token)
})
it('does not admit non-owners and resumes retained storage without minting a new token',async()=>{
 await expect(startLizardCompute(f.env,await f.actor(ids.member))).rejects.toMatchObject({statusCode:403})
 controller.status.mockResolvedValue({phase:'stopped',workspaceId:'b5949476-1a4e-4141-bfc6-a72a7751fd95',nodeId:'node',retainedStorage:true})
 await startLizardCompute(f.env,await f.actor())
 expect(controller.start).toHaveBeenCalledWith('b5949476-1a4e-4141-bfc6-a72a7751fd95')
 expect(f.db.prepare('SELECT count(*) AS n FROM compute_pairings').get()!.n).toBe(0)
})
it('starts the selected managed node on demand and lets only the owner stop it',async()=>{
 controller.ensure.mockResolvedValue({phase:'vm'})
 expect(await ensureLizardCompute(f.env,'node-a')).toMatchObject({phase:'vm'})
 await expect(stopLizardCompute(f.env,await f.actor(ids.member))).rejects.toMatchObject({statusCode:403})
 controller.stop.mockResolvedValue({phase:'stopping'})
 expect(await stopLizardCompute(f.env,await f.actor())).toMatchObject({phase:'stopping'})
})

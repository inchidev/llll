import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpFixture, remoteMcp, ids } from '../helpers/outbound-mcp'
import { toolsSettings, toolAudit } from '../../server/utils/agent-tools-settings'
import { deleteMcpConnection, saveMcpConnection } from '../../server/utils/outbound-mcp'
import { Permission } from '../../shared/permissions'
let f: ReturnType<typeof mcpFixture>
beforeEach(()=>{f=mcpFixture();remoteMcp()})
afterEach(()=>{f.db.close();vi.unstubAllGlobals()})
it('previews only current Agent/initiator grants without creating executable Runs or decrypting credentials',async()=>{
 const connection=await f.connect(f.input({credential:'synthetic-ui-secret'}))
 const result=await toolsSettings(f.env,await f.actor(),ids.agent)
 expect(result.preview?.tools.some(t=>t.provenance?.connectionId===connection.id)).toBe(true)
 expect(JSON.stringify(result)).not.toContain('synthetic-ui-secret')
 expect(f.db.prepare('SELECT count(*) AS n FROM agent_runs').get()!.n).toBe(0)
 expect(f.db.prepare('SELECT count(*) AS n FROM agent_run_tools').get()!.n).toBe(0)
 expect(result.capabilities.find(c=>c.name==='External writes and approvals')?.available).toBe(false)
})
it('hides an unshared integration even from Owner in the Agent exposure preview',async()=>{
 const c=await f.connect(f.input({grants:{agentIds:[ids.agent],memberIds:[ids.member],roleIds:[]}}))
 expect((await toolsSettings(f.env,await f.actor(),ids.agent)).preview?.tools.some(t=>t.provenance?.connectionId===c.id)).toBe(false)
 expect((await toolsSettings(f.env,await f.actor(ids.member),ids.agent)).preview?.tools.some(t=>t.provenance?.connectionId===c.id)).toBe(true)
})
it('removes disabled and revoked tools from a previously available preview',async()=>{
 const c=await f.connect()
 await saveMcpConnection(f.env,await f.actor(),f.input({enabled:false}),c.id)
 expect((await toolsSettings(f.env,await f.actor(),ids.agent)).preview?.tools.some(t=>t.provenance?.connectionId===c.id)).toBe(false)
 f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.sendMessages,ids.agentRole)
 const result=await toolsSettings(f.env,await f.actor(),ids.agent)
 expect(result.preview?.tools.some(t=>t.name==='list_tasks')).toBe(false)
 expect(result.preview?.diagnostics.some(d=>d.includes('Read tasks is unavailable'))).toBe(true)
})
it('denies unauthorized, non-session and foreign-Server metadata requests',async()=>{
 f.db.prepare('UPDATE roles SET permissions_bitmask=0 WHERE id=?').run(ids.memberRole)
 await expect(toolsSettings(f.env,await f.actor(ids.member))).rejects.toMatchObject({statusCode:403})
 const actor=await f.actor();actor.credential.kind='mcp'
 await expect(toolsSettings(f.env,actor)).rejects.toMatchObject({statusCode:403})
 actor.credential.kind='session';actor.serverId=crypto.randomUUID()
 await expect(toolsSettings(f.env,actor)).rejects.toMatchObject({statusCode:404})
})
it('keeps personal audit private, including after revocation, and omits raw metadata',async()=>{
 const personal=await f.connect(f.input({name:'Private member docs',ownership:'member',credential:'synthetic-private-token',grants:{agentIds:[ids.agent],memberIds:[],roleIds:[]}}),ids.member)
 const server=await f.connect()
 const owner=await toolAudit(f.env,await f.actor(),'',1),member=await toolAudit(f.env,await f.actor(ids.member),'',1)
 expect(owner.entries.some(e=>e.connectionId===personal.id)).toBe(false)
 expect(owner.entries.some(e=>e.connectionId===server.id)).toBe(true)
 expect(member.entries.some(e=>e.connectionId===personal.id)).toBe(true)
 expect(member.entries.some(e=>e.connectionId===server.id)).toBe(false)
 expect(JSON.stringify(member)).not.toMatch(/synthetic-private-token|credential_json|grants_json|Private member docs/)
 await deleteMcpConnection(f.env,await f.actor(ids.member),personal.id)
 expect((await toolAudit(f.env,await f.actor(),'',1)).entries.some(e=>e.connectionId===personal.id)).toBe(false)
 expect((await toolAudit(f.env,await f.actor(ids.member),'',1)).entries.some(e=>e.connectionId===personal.id&&e.action==='tool.connection.delete')).toBe(true)
})
it('fails closed on legacy deleted connections with unknown ownership and supports safe audit search',async()=>{
 f.db.prepare("INSERT INTO audit_log(id,actor_id,action,target_type,target_id,meta_json,created_at) VALUES(?, ?, 'tool.connection.call','tool_connection','removed-private',?,?)").run(crypto.randomUUID(),ids.agent,JSON.stringify({runId:'unknown',tool:'restricted-tool',status:'completed',credential:'never-return'}),new Date().toISOString())
 expect((await toolAudit(f.env,await f.actor(),'restricted',1)).total).toBe(0)
 const c=await f.connect();const filtered=await toolAudit(f.env,await f.actor(),'configure',1)
 expect(filtered.entries.every(e=>e.action==='tool.connection.configure')).toBe(true)
 expect(filtered.entries.some(e=>e.connectionId===c.id)).toBe(true)
 f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.useAgents,ids.memberRole)
 await expect(toolAudit(f.env,await f.actor(ids.member),'',1)).rejects.toMatchObject({statusCode:403})
})

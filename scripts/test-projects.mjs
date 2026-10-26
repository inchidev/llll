import assert from 'node:assert/strict'
import { Permission } from '../shared/permissions.ts'
export async function testProjects({ api, runtimes, ids, memberId }) {
 const root = `/api/servers/${ids.alpha}`, db = await runtimes.alpha.getD1Database('DB')
 await api('alpha', root+'/projects', { actor: 'anonymous', expected: 401 })
 await api('alpha', root+'/projects', { actor: 'alpha-member', expected: 403 })
 await api('beta', root+'/projects', { expected: 404 })
 const project = (await api('alpha', root+'/projects', { method: 'POST', body: { name: 'Factory A', description: 'Private project metadata' } })).payload.project
 const other = (await api('alpha', root+'/projects', { method: 'POST', body: { name: 'Factory B' } })).payload.project
 const endpoint = `/api/projects/${project.id}`
 const role = (await api('alpha', root+'/roles', { method: 'POST', body: { name: 'Project reader', permissions: Permission.readProjects|Permission.readTasks|Permission.writeTasks|Permission.sendMessages, resourceAccess: { projects: [project.id] } } })).payload.role
 const original = (await db.prepare('SELECT role_id AS role FROM users WHERE id=?').bind(memberId).first()).role
 await db.prepare('UPDATE users SET role_id=? WHERE id=?').bind(role.id,memberId).run()
 try {
  const visible = (await api('alpha', root+'/projects', { actor: 'alpha-member' })).payload.projects
  assert.deepEqual(visible.map(p=>p.id),[project.id])
  await api('alpha', `/api/projects/${other.id}`, { actor:'alpha-member', expected:403 })
  await api('alpha', root+'/projects', { actor:'alpha-member', method:'POST', body:{name:'Escalation'}, expected:403 })
  await api('alpha', endpoint, { actor:'alpha-member', method:'PATCH', body:{version:1,name:'Escalation'}, expected:403 })
  const reference = { provider:'github',host:'https://github.com',externalId:'1380041578',slug:'inchidev/afterprompt',defaultBranch:'main' }
  await api('alpha', endpoint+'/repositories', { actor:'alpha-member',method:'POST',body:reference,expected:403 })
  const repository = (await api('alpha', endpoint+'/repositories', { method:'POST',body:reference })).payload.repository
  assert.equal(repository.environmentId,null)
  await api('alpha', endpoint+'/repositories', { method:'POST',body:reference,expected:409 })
  await api('alpha', endpoint+'/repositories', { method:'POST',body:{provider:'gitea',host:'https://git.example.test',slug:'team/backend',defaultBranch:'develop'} })
  assert.equal((await api('alpha',endpoint,{actor:'alpha-member'})).payload.repositories.length,2)
  const board = (await api('alpha',root+'/boards',{method:'POST',body:{name:'Project access fixture'}})).payload.board
  const taskBody = { title:'Project task', description:'Private project task payload', assigneeId:null,channelId:null }
  const task = (await api('alpha',`/api/boards/${board.id}/tasks`,{method:'POST',body:{...taskBody,projectId:project.id}})).payload.task
  const hidden = (await api('alpha',`/api/boards/${board.id}/tasks`,{method:'POST',body:{...taskBody,projectId:other.id,title:'Hidden project task'}})).payload.task
  assert.equal((await api('alpha',`/api/tasks/${task.id}`,{actor:'alpha-member'})).payload.task.projectId,project.id)
  await api('alpha',`/api/tasks/${hidden.id}`,{actor:'alpha-member',expected:403})
  await api('alpha',`/api/tasks/${hidden.id}`,{actor:'alpha-member',method:'PATCH',body:{title:'Bypass'},expected:403})
  const listed = (await api('alpha',root+'/boards',{actor:'alpha-member'})).payload.boards.flatMap(b=>b.tasks)
  assert.ok(listed.some(t=>t.id===task.id));assert.ok(!listed.some(t=>t.id===hidden.id))
  const discussion = (await api('alpha',`/api/tasks/${task.id}/discussion`,{actor:'alpha-member',method:'POST',body:{}})).payload.channelId
  await api('alpha',`/api/channels/${discussion}/messages`,{actor:'alpha-member'})
  await db.prepare('UPDATE roles SET resource_access_json=? WHERE id=?').bind('{"projects":[]}',role.id).run()
  await api('alpha',`/api/channels/${discussion}/messages`,{actor:'alpha-member',expected:403})
  await api('alpha',`/api/tasks/${task.id}`,{actor:'alpha-member',expected:403})
  const archived = (await api('alpha',endpoint,{method:'PATCH',body:{version:project.version,archived:true}})).payload.project
  await api('alpha',endpoint,{method:'PATCH',body:{version:project.version,name:'Stale'},expected:409})
  await api('alpha',endpoint+'/repositories',{method:'POST',body:{...reference,externalId:'another'},expected:409})
  await api('alpha',endpoint,{method:'PATCH',body:{version:archived.version,archived:false}})
  console.log('PASS: Projects HTTP CRUD, multiple provider references, Role/project/Task scopes, discussion revocation, versioned archive and cross-server isolation')
  return { projectId:project.id,taskId:task.id }
 } finally { await db.prepare('UPDATE users SET role_id=? WHERE id=?').bind(original,memberId).run() }
}

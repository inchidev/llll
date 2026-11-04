import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openNodeState, serverOrigin } from '../src/state-store.mjs'
import { runProcess } from '../src/process.mjs'

test('Node journal binds one validated connection to the configured Server and survives restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'l4-state-'))
  const connection={nodeId:randomUUID(),serverId:randomUUID(),token:'a'.repeat(64)}
  let store
  try {
    store=await openNodeState(directory)
    assert.equal(store.connection('https://server.example'),null)
    for(const value of [{...connection,token:'bad'}, {...connection,nodeId:'../escape'}])assert.throws(()=>store.pair('https://server.example',value))
    store.pair('https://server.example',connection)
    assert.throws(()=>store.pair('https://server.example',connection))
    assert.throws(()=>store.connection('https://other.example'),/different Server/u)
    store.close();store=await openNodeState(directory)
    assert.deepEqual(store.connection('https://server.example'),{server:'https://server.example',...connection})
    assert.equal((await stat(join(directory,'node-state.sqlite'))).mode & 0o777,0o600)
    assert.equal((await stat(directory)).mode & 0o777,0o700)
  } finally {store?.close();await rm(directory,{recursive:true,force:true})}
})
test('receipts persist exactly once, preserve evidence, reject changed identity and acknowledge only the exact lease',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'l4-receipts-'))
  const receipt={operation:'result',id:randomUUID(),lease:'b'.repeat(64),result:{ok:false,exitCode:1,output:'test failed; ; $(not a command)',runtimeMs:1000}}
  let store
  try {
    store=await openNodeState(directory);store.retain(receipt);store.retain(receipt)
    assert.throws(()=>store.retain({...receipt,lease:'c'.repeat(64)}),/identity/u)
    assert.throws(()=>store.retain({...receipt,result:{...receipt.result,output:'changed'}}),/identity/u)
    assert.throws(()=>store.retain({...receipt,id:'../../escape'}))
    assert.throws(()=>store.retain({...receipt,id:randomUUID(),result:{...receipt.result,output:'x'.repeat(64001)}}))
    store.close();store=await openNodeState(directory)
    assert.deepEqual(store.receipts(),[receipt])
    store.acknowledge(receipt.id,'c'.repeat(64));assert.equal(store.receipts().length,1)
    store.acknowledge(receipt.id,receipt.lease);assert.deepEqual(store.receipts(),[])
    for(let i=0;i<128;i++)store.retain({...receipt,id:randomUUID()})
    assert.throws(()=>store.retain({...receipt,id:randomUUID()}),/capacity/u)
    assert.equal(store.receipts().length,128)
  } finally {store?.close();await rm(directory,{recursive:true,force:true})}
})
test('Node state rejects symlinks and requires a safe explicit Server origin',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'l4-state-path-'))
  try {
    await writeFile(join(directory,'elsewhere'),'private')
    await symlink(join(directory,'elsewhere'),join(directory,'node-state.sqlite'))
    await assert.rejects(openNodeState(directory),/Unsafe/u)
    for(const value of ['http://remote.example','https://user:pass@server.example','https://server.example/other','https://server.example?x=1'])assert.throws(()=>serverOrigin(value))
    assert.equal(serverOrigin('http://127.0.0.1:3000'),'http://127.0.0.1:3000')
  } finally {await rm(directory,{recursive:true,force:true})}
})
test('host process launcher never exposes a shell or arbitrary executable',async()=>{
  for(const tool of ['/bin/sh','sh','bash','node','__proto__','/tmp/docker'])await assert.rejects(runProcess(tool,['-c','exit 0']),/Unsupported/u)
  await assert.rejects(runProcess('git',['--version\0']),/Unsupported/u)
  assert.equal((await runProcess('git',['--version'])).code,0)
})


function inspectState(directory, read) {
  const database = new DatabaseSync(join(directory, 'node-state.sqlite'))
  try { return read(database) } finally { database.close() }
}

test('pending local pairing keeps one private identity across retries and process restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'l4-local-intent-'))
  let store
  try {
    store = await openNodeState(directory)
    const first = store.localPairing('https://server.example')
    assert.match(first.nodeId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
    assert.match(first.token, /^[a-f0-9]{64}$/u)
    assert.deepEqual(Object.keys(first).sort(), ['nodeId', 'token'])
    for (let attempt = 0; attempt < 5; attempt++) assert.deepEqual(store.localPairing('https://server.example/'), first)
    assert.equal(store.connection('https://server.example'), null)
    store.close(); store = await openNodeState(directory)
    assert.deepEqual(store.localPairing('https://server.example'), first)
    assert.deepEqual(inspectState(directory, db => db.prepare('SELECT count(*) AS total FROM local_pairing').get()).total, 1)
    assert.equal((await stat(join(directory, 'node-state.sqlite'))).mode & 0o777, 0o600)
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }) }
})

test('local pairing rejects unsafe or changed Server origins without replacing a pending identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'l4-local-origin-'))
  let store
  try {
    store = await openNodeState(directory)
    for (const origin of ['http://remote.example', 'https://user:pass@server.example', 'https://server.example/path', 'https://server.example?scope=other']) {
      assert.throws(() => store.localPairing(origin))
    }
    assert.equal(inspectState(directory, db => db.prepare('SELECT count(*) AS total FROM local_pairing').get()).total, 0)
    const intent = store.localPairing('https://server.example')
    assert.throws(() => store.localPairing('https://other.example'), /local pairing intent or Server origin/u)
    assert.deepEqual(store.localPairing('https://server.example'), intent)
    store.close(); store = await openNodeState(directory)
    assert.throws(() => store.localPairing('https://other.example'), /local pairing intent or Server origin/u)
    assert.deepEqual(store.localPairing('https://server.example'), intent)
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }) }
})

for (const [column, invalid] of [
  ['node_id', '../../another-node'], ['node_id', 'not-a-uuid'],
  ['token', 'g'.repeat(64)], ['token', 'a'.repeat(65)],
  ['server', 'https://other.example'], ['server', 'https://server.example/private'],
]) {
  test(`local pairing refuses a malformed persisted ${column} without minting a replacement`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'l4-local-invalid-'))
    let store
    try {
      store = await openNodeState(directory)
      store.localPairing('https://server.example')
      store.close()
      const corrupted = inspectState(directory, db => {
        db.prepare(`UPDATE local_pairing SET ${column}=? WHERE singleton=1`).run(invalid)
        return db.prepare('SELECT * FROM local_pairing').get()
      })
      store = await openNodeState(directory)
      assert.throws(() => store.localPairing('https://server.example'), /local pairing intent or Server origin/u)
      assert.deepEqual(inspectState(directory, db => db.prepare('SELECT * FROM local_pairing').get()), corrupted)
      assert.equal(store.connection('https://server.example'), null)
    } finally { store?.close(); await rm(directory, { recursive: true, force: true }) }
  })
}

test('finalizing a matching local pairing clears its intent durably and preserves recovery receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'l4-local-finalize-'))
  const receipt = { operation: 'result', id: randomUUID(), lease: 'b'.repeat(64), result: { ok: true, exitCode: 0, output: 'Retained receipt', runtimeMs: 10 } }
  let store
  try {
    store = await openNodeState(directory)
    const intent = store.localPairing('https://server.example'), serverId = randomUUID()
    store.retain(receipt)
    assert.throws(() => store.pair('https://server.example', { ...intent, serverId: '../invalid-server' }), /Invalid Node pairing response/u)
    assert.deepEqual(store.localPairing('https://server.example'), intent)
    store.pair('https://server.example', { ...intent, serverId })
    assert.equal(inspectState(directory, db => db.prepare('SELECT count(*) AS total FROM local_pairing').get()).total, 0)
    store.close(); store = await openNodeState(directory)
    assert.deepEqual(store.connection('https://server.example'), { server: 'https://server.example', ...intent, serverId })
    assert.equal(inspectState(directory, db => db.prepare('SELECT count(*) AS total FROM local_pairing').get()).total, 0)
    assert.deepEqual(store.receipts(), [receipt])
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a failed intent finalization rolls back its connection and leaves the same identity available for recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'l4-local-atomic-'))
  let store
  try {
    store = await openNodeState(directory)
    const intent = store.localPairing('https://server.example'), connection = { ...intent, serverId: randomUUID() }
    inspectState(directory, db => db.exec("CREATE TRIGGER refuse_local_finalize BEFORE DELETE ON local_pairing BEGIN SELECT RAISE(ABORT,'forced intent finalization failure'); END"))
    assert.throws(() => store.pair('https://server.example', connection), /forced intent finalization failure/u)
    assert.equal(store.connection('https://server.example'), null)
    assert.deepEqual(store.localPairing('https://server.example'), intent)
    store.close(); store = await openNodeState(directory)
    assert.equal(store.connection('https://server.example'), null)
    assert.deepEqual(store.localPairing('https://server.example'), intent)
    inspectState(directory, db => db.exec('DROP TRIGGER refuse_local_finalize'))
    store.pair('https://server.example', connection)
    assert.deepEqual(store.connection('https://server.example'), { server: 'https://server.example', ...connection })
    assert.equal(inspectState(directory, db => db.prepare('SELECT count(*) AS total FROM local_pairing').get()).total, 0)
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }) }
})

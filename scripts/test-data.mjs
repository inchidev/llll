import assert from 'node:assert/strict'

/** Real Worker/D1 routes, isolated from customer Servers. */
export async function testData({ api, ids }) {
  const database = (await api('alpha', `/api/servers/${ids.alpha}/databases`, { method: 'POST', body: { name: 'Data integration', fields: [{ name: 'Score', type: 'number' }] } })).payload.database
  const field = database.fields[0]
  const rows = [{ requestId: 'integration-one', title: 'First', values: { [field.id]: 1 } }, { requestId: 'integration-bad', title: 'Invalid', values: { [field.id]: 'bad' } }]
  const preview = (await api('alpha', `/api/databases/${database.id}/import`, { method: 'POST', body: { rows } })).payload
  assert.deepEqual(preview.results.map(row => row.ok), [true, false])
  const write = (await api('alpha', `/api/databases/${database.id}/import`, { method: 'POST', body: { rows, preview: false } })).payload
  const retry = (await api('alpha', `/api/databases/${database.id}/import`, { method: 'POST', body: { rows, preview: false } })).payload
  assert.equal(write.results[0].recordId, retry.results[0].recordId)
  const recordId = write.results[0].recordId
  const exported = await api('alpha', `/api/databases/${database.id}/export`)
  assert.match(await exported.response.text(), /Title,Score\r\nFirst,1/)
  await api('beta', `/api/databases/${database.id}`, { expected: 404 })
  // Different logical types sharing one physical pool must both survive.
  const fieldResponses = await Promise.all(['text', 'url'].map((type, index) => api('alpha', `/api/databases/${database.id}/fields`, { method: 'POST', body: { name: `Concurrent ${index}`, type, options: [] } })))
  assert.equal(fieldResponses.length, 2)
  const doc = (await api('alpha', `/api/servers/${ids.alpha}/documents`, { method: 'POST', body: { title: 'Data integration brief', content: '# Finding\n\nRare evidence\n<script>alert(1)</script>', format: 'markdown' } })).payload.document
  assert.match(doc.content, /<h1>Finding<\/h1>/)
  assert.doesNotMatch(doc.content, /script|alert\(1\)/)
  await api('alpha', `/api/documents/${doc.id}`, { method: 'PATCH', body: { version: 1, content: '<p>Updated</p>' } })
  const revisions = (await api('alpha', `/api/documents/${doc.id}/revisions`)).payload.revisions
  assert.equal(revisions[0].version, 1)
  await api('alpha', `/api/documents/${doc.id}/restore`, { method: 'POST', expected: 409, body: { version: 1, revision: 1 } })
  await api('alpha', `/api/documents/${doc.id}/restore`, { method: 'POST', body: { version: 2, revision: 1 } })
  assert.ok((await api('alpha', '/api/data-search?q=Rare%20evidence')).payload.hits.some(hit => hit.id === doc.id))
  await api('alpha', '/api/data-references', { method: 'POST', body: { source: { type: 'record', id: recordId }, target: { type: 'document', id: doc.id } } })
  assert.equal((await api('alpha', `/api/data-references?type=document&id=${doc.id}`)).payload.incoming[0].id, recordId)
  await api('alpha', `/api/database-items/${recordId}`, { method: 'DELETE' })
  assert.equal((await api('alpha', `/api/databases/${database.id}`)).payload.total, 0)
  assert.equal((await api('alpha', `/api/data-references?type=document&id=${doc.id}`)).payload.incoming.length, 0)
  await api('alpha', '/api/data-trash', { method: 'POST', body: { type: 'record', id: recordId, action: 'restore' } })
  assert.equal((await api('alpha', `/api/databases/${database.id}`)).payload.items[0].values[field.id], 1)
  await api('alpha', `/api/documents/${doc.id}`, { method: 'DELETE' })
  await api('alpha', `/api/documents/${doc.id}`, { expected: 404 })
  await api('alpha', '/api/data-trash', { method: 'POST', body: { type: 'document', id: doc.id, action: 'restore' } })
  for (const [type, id, route] of [['document', doc.id, 'documents'], ['database', database.id, 'databases']]) {
    await api('alpha', `/api/${route}/${id}`, { method: 'DELETE' })
    await api('alpha', '/api/data-trash', { method: 'POST', body: { type, id, action: 'purge' } })
  }
  console.log('Data integration passed: CSV retries, slots, safe Markdown, history, search, links and Trash')
}

import assert from 'node:assert/strict'

/** Real bytes a Photos share sends: a MOV container, which the Server stores as video/mp4. */
export const MOV = (size = 64) => {
  const bytes = new Uint8Array(size)
  bytes.set([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20])
  return bytes
}

/** What the Shortcut sends; Miniflare's fetch leaves the length to the caller. */
export const shortcutHeaders = body => ({ 'Content-Type': 'video/quicktime', 'Content-Length': String(body.length) })
export const shortcutLink = key => `/api/recordings?key=${key}`

/**
 * The phone's path against a real Worker, as the Shortcut sends it: a raw body, a key, no cookie,
 * no Origin. `post` sends it; `api` is the signed-in person; `count` reads how many Tasks exist.
 */
export async function testRecordingKeys({ post, api, count, serverRoot, boards, expectedBoard = 'Shots' }) {
  const before = await count()
  const send = (key, options = {}) => {
    const body = options.body ?? MOV()
    return post(shortcutLink(key), shortcutHeaders(body), body)
  }

  // A bad key creates nothing, in every shape, and never says why beyond "it doesn't work".
  for (const bad of ['l4rec_' + '0'.repeat(64), 'dfmcp_' + '0'.repeat(64), 'nonsense']) {
    const refused = await send(bad)
    assert.equal(refused.status, 200, 'The Shortcut opens whatever comes back')
    assert.match(await refused.text(), /\/recording-problem\?why=unauthorized$/u)
  }
  assert.equal(await count(), before, 'A POST with a bad key creates nothing')

  const created = (await api('/api/me/recording-keys', { method: 'POST', body: { name: 'iPhone' } })).key
  assert.match(created.token, /^l4rec_[0-9a-f]{64}$/u)
  assert.equal((await api('/api/me/recording-keys')).keys.some(key => key.id === created.id && !('token' in key)), true, 'The list never holds the key')

  // The key opens the upload and nothing else, not even what its person can reach.
  for (const [path, init] of [['/api/me', {}], [`${serverRoot}/boards`, {}], ['/mcp', { method: 'POST', body: '{}' }]]) {
    const other = await post(`${path}?key=${created.token}`, { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' }, init.body, init.method ?? 'GET')
    assert.equal(other.status, 401, `A key must not open ${path}`)
  }

  const first = await send(created.token)
  assert.equal(first.status, 200)
  const link = new URL(await first.text())
  const taskId = link.pathname.match(/^\/projects\/mark\/([^/]+)$/u)?.[1]
  assert.ok(taskId, `The answer is the marking page: ${link}`)
  assert.equal(link.searchParams.get('key'), created.id)
  assert.equal(await count(), before + 1)

  const { task } = await api(`/api/tasks/${taskId}`)
  assert.equal(task.title, 'Screen recording')
  const recording = task.attachments.find(attachment => attachment.role === 'recording')
  assert.equal(recording.contentType, 'video/mp4', 'MOV plays as MP4')
  const board = (await boards()).find(candidate => candidate.id === task.boardId)
  assert.equal(board.name, expectedBoard)
  assert.equal((await boards()).filter(candidate => candidate.name === expectedBoard).length, 1, 'Made on first use, once')

  // Marking updates that same Task: the comment takes over the title.
  const clip = { start: 0, end: 1, box: null, comment: 'Pay now does nothing' }
  const finished = (await api(`/api/task-attachments/${recording.id}/finish`, { method: 'POST', body: { duration: 2, clips: [clip], transcript: [] } })).task
  assert.equal(finished.id, taskId)
  assert.equal(finished.title, 'Pay now does nothing')
  assert.match(finished.description, /Pay now does nothing/u)

  // The apps send the file, then its marks and frames, all by key. A key still opens nothing else of the Task.
  const appFile = new URL(await (await send(created.token)).text()).pathname.split('/').pop()
  const limits = await post(`/api/recordings/limits?key=${created.token}`, {}, undefined, 'GET')
  assert.equal(limits.status, 200)
  assert.equal(typeof (await limits.json()).limits.maxUploadBytes, 'number')
  const jpeg = new Uint8Array(64)
  jpeg.set([0xff, 0xd8, 0xff, 0xe0])
  const form = new FormData()
  form.append('marks', JSON.stringify({ duration: 2, clips: [{ start: 0, end: 1, box: null, comment: 'Marked on the phone' }], transcript: [] }))
  form.append('frames', JSON.stringify([{ clip: 0, t: 0.5, zoom: false }]))
  form.append('frame', new Blob([jpeg], { type: 'image/jpeg' }), 'c1-00.jpg')
  const encoded = new Response(form)
  const marksBody = new Uint8Array(await encoded.arrayBuffer())
  const marksHeaders = { 'Content-Type': encoded.headers.get('content-type') }
  assert.equal((await post(`/api/recordings/${appFile}/marks`, marksHeaders, marksBody)).status, 401, 'Marks need the key')
  assert.equal((await post(`/api/recordings/${appFile}/marks?key=${created.token}`, marksHeaders, marksBody)).status, 200)
  assert.equal((await post(`/api/recordings/${appFile}/marks?key=${created.token}`, marksHeaders, marksBody)).status, 200, 'Sent twice changes nothing')
  const marked = (await api(`/api/tasks/${appFile}`)).task
  assert.equal(marked.title, 'Marked on the phone')
  assert.equal(marked.attachments.filter(attachment => attachment.role === 'frame').length, 1)
  assert.equal((await post(`/api/recordings/voice?key=${created.token}`, { 'Content-Type': 'audio/wav' }, new Uint8Array(10))).status, 400, 'Voice takes the key and checks the audio')
  assert.equal((await post(`/api/recordings/voice`, { 'Content-Type': 'audio/wav' }, new Uint8Array(100))).status, 401, 'Voice needs the key')
  assert.equal((await post(`/api/tasks/${appFile}?key=${created.token}`, { 'Content-Type': 'application/json' }, '{}', 'PATCH')).status, 401, 'A key opens nothing else of the Task')

  // A file that isn't a recording, or is empty, leaves no Task behind.
  const notMedia = await send(created.token, { body: new TextEncoder().encode('not a recording, just some text here') })
  assert.match(await notMedia.text(), /why=unsupported_type$/u)
  assert.match(await (await send(created.token, { body: new Uint8Array() })).text(), /why=length_required$/u)
  assert.equal(await count(), before + 2, 'A refused file leaves nothing behind')

  // The board this device chose next time, and turning the key off.
  const second = (await api(`${serverRoot}/boards`, { method: 'POST', body: { name: 'Elsewhere' } })).board
  await api(`/api/me/recording-keys/${created.id}`, { method: 'PATCH', body: { boardId: second.id } })
  const again = new URL(await (await send(created.token)).text()).pathname.split('/').pop()
  assert.equal((await api(`/api/tasks/${again}`)).task.boardId, second.id)
  await api(`/api/me/recording-keys/${created.id}`, { method: 'DELETE' })
  assert.match(await (await send(created.token)).text(), /why=unauthorized$/u)
  assert.equal(await count(), before + 3)
  return { taskId, boardId: task.boardId }
}

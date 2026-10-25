import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

/** A real signed HTTP delivery exercises parsing, storage, deduplication and permanent rejection. */
export async function testInboundMail({ runtimes, origins, signingSecret }) {
  const db = await runtimes.alpha.getD1Database('DB')
  const mailbox = crypto.randomUUID(), domain = crypto.randomUUID()
  await db.batch([
    db.prepare("INSERT INTO channels(id,name,type,visibility) VALUES(?,'QA inbound mail','text','private')").bind(mailbox),
    db.prepare("INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES(?,'fixture','inbound.example.test','localhost')").bind(domain),
    db.prepare("INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES(?,?,'support','QA inbound')").bind(mailbox, domain),
  ])
  const from = 'sender@example.test', to = 'support@inbound.example.test'
  const deliver = async (raw, authenticated = true) => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = createHmac('sha256', signingSecret).update(`${timestamp}.${from}.${to}.`).update(raw).digest('hex')
    return runtimes.alpha.dispatchFetch(origins.alpha + '/api/email/inbound', { method: 'POST', headers: {
      'Content-Type': 'message/rfc822', 'x-llll-email-timestamp': timestamp, 'x-llll-email-from': from, 'x-llll-email-to': to,
      'x-llll-email-signature': authenticated ? signature : '0'.repeat(64),
    }, body: raw })
  }
  const raw = ['From: Sender <sender@example.test>', 'To: support@inbound.example.test', 'Message-ID: <qa-inbound@example.test>',
    'Subject: =?UTF-8?B?UXVhbGl0eSDwn5iA?=', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="qa"', '',
    '--qa', 'Content-Type: text/plain; charset=UTF-8', '', 'Signed inbound smoke', '--qa', 'Content-Type: text/plain',
    'Content-Disposition: attachment; filename="evidence.txt"', 'Content-Transfer-Encoding: base64', '', Buffer.from('private evidence').toString('base64'), '--qa--'].join('\r\n')
  assert.equal((await deliver(raw, false)).status, 401)
  assert.equal((await deliver(raw)).status, 202)
  assert.equal((await deliver(raw)).status, 202)
  const stored = await db.prepare('SELECT subject FROM email_threads WHERE mailbox_channel_id=?').bind(mailbox).all()
  assert.equal(stored.results.length, 1); assert.equal(stored.results[0].subject, 'Quality 😀')
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM email_messages WHERE mailbox_channel_id=?').bind(mailbox).first()).n, 1)
  const oversized = 'From: sender@example.test\r\nTo: support@inbound.example.test\r\nSubject: ' + 'a'.repeat(2 * 1024 * 1024 + 1) + '\r\n\r\nBody'
  const refusal = await deliver(oversized)
  assert.equal(refusal.status, 422)
  assert.match(await refusal.text(), /parser limits/)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM email_messages WHERE mailbox_channel_id=?').bind(mailbox).first()).n, 1)
  console.log('PASS: real signed inbound RFC822 HTTP, encoded subject, multipart attachment, deduplicated storage and permanent parser-limit refusal')
}

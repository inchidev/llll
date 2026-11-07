import { connect } from 'node:net'

/**
 * The daemon's way into a box: `docker exec -i l4-box-<id> node /opt/agent/src/control.mjs` with one
 * request on stdin, `{op:'turn',submission}`, `{op:'cancel'}` or `{op:'health'}`. It passes the request to
 * the box's socket and prints the answers, one JSON line each; a turn's last line comes when it ends.
 */
const socket = process.env.LLLL_BOX_SOCKET || '/run/l4/control.sock'
// As box.mjs reads it; this entry stays small so each exec starts fast.
const CONTROL_BYTES = 2_600_000
const chunks = []
let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > CONTROL_BYTES) { process.stdout.write(JSON.stringify({ error: 'Request too large' }) + '\n'); process.exit(1) }
  chunks.push(chunk)
}
const request = Buffer.concat(chunks).toString('utf8').trim()
// A box that has just started may not listen yet. Only a connection that opened is piped to stdout: a
// refused one would leave its pipe listeners on stdout, one more each attempt.
for (let attempt = 0; ; attempt++) {
  try {
    await new Promise((resolve, reject) => {
      const connection = connect(socket)
      connection.once('connect', () => {
        connection.pipe(process.stdout, { end: false })
        connection.once('close', resolve)
        connection.end(request + '\n')
      })
      connection.once('error', error => { connection.unpipe(process.stdout); connection.destroy(); reject(error) })
    })
    break
  } catch (error) {
    if (attempt >= 40 || !['ENOENT', 'ECONNREFUSED'].includes(error.code)) { process.stdout.write(JSON.stringify({ error: 'The box is not running' }) + '\n'); process.exitCode = 1; break }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

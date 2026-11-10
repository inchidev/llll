// The box's viewer: voxl streaming the box's screen, in a container of its own beside the box. It shares only the
// box's X socket and System V shared memory (for Xvfb's -shmem framebuffer); it has no network at all. voxl listens
// on loopback inside this container, and this script carries connections to it from a Unix socket in a directory
// the daemon mounts, where the daemon's preview gate (preview-gate.mjs) reaches it. voxl's password comes from
// the daemon in VOXL_PASSWORD and never enters the box.
import { spawn } from 'node:child_process'
import { access, rm } from 'node:fs/promises'
import { connect, createServer } from 'node:net'

export const VOXL = '/opt/voxl/bin/voxl'
export const VOXL_PORT = 6902
export const VIEW_SOCKET = '/run/l4-view/voxl.sock'

/** voxl's flags for a box: one viewer watches, nothing goes in, no sound, no files, no clipboard. */
export function voxlArguments(origins = []) {
  const allowed = origins.filter(origin => /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/u.test(origin))
  return [`--addr=127.0.0.1`, `--port=${VOXL_PORT}`, '--title=L4 box', '--read-only=true', '--audio-enabled=false', '--enable-clipboard=false',
    '--file-transfers=none', '--microphone-enabled=false', '--enable-resize=false',
    // Only the daemon's gate reaches this port, by the socket below; it has checked the viewer's ticket.
    '--allowed-hosts=*', ...(allowed.length ? [`--allowed-origins=${allowed.join(',')}`] : [])]
}

/** The X socket of a display such as `:99`. */
export const displaySocket = display => `/tmp/.X11-unix/X${/^:(\d{1,4})$/u.exec(display ?? '')?.[1] ?? '99'}`

if (process.argv[1] && process.argv[1].endsWith('/viewer.mjs')) {
  if (!/^[a-f0-9]{64}$/u.test(process.env.VOXL_PASSWORD ?? '')) { console.error('viewer: no password'); process.exit(2) }
  const origins = (process.env.LLLL_VIEW_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean)
  let child = null, stopping = false
  const start = async () => {
    // The box starts its screen as it starts; voxl needs it there.
    for (let attempt = 0; !stopping; attempt++) {
      try { await access(displaySocket(process.env.DISPLAY)); break } catch { await new Promise(resolve => setTimeout(resolve, Math.min(2000, 100 * (attempt + 1)))) }
    }
    if (stopping) return
    child = spawn(VOXL, voxlArguments(origins), { stdio: ['ignore', 'ignore', 'inherit'], env: { PATH: process.env.PATH, HOME: '/tmp', DISPLAY: process.env.DISPLAY ?? ':99', VOXL_PASSWORD: process.env.VOXL_PASSWORD, RUST_LOG: 'warn' } })
    child.on('exit', () => { child = null; if (!stopping) setTimeout(start, 1000) })
  }
  await rm(VIEW_SOCKET, { force: true })
  const server = createServer(socket => {
    const upstream = connect(VOXL_PORT, '127.0.0.1')
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
  })
  server.listen(VIEW_SOCKET)
  void start()
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; child?.kill('SIGTERM'); server.close(); process.exit(0) })
}

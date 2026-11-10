import { spawn } from 'node:child_process'

/** The box's screen: what the Agent's browser draws on and what a person watching the box sees. */
export const BOX_SCREEN = '1280x720x24'

/** Xvfb's arguments for a display such as `:99`: its framebuffer in shared memory for the viewer, and no network listener. */
export function displayArguments(display, screen = BOX_SCREEN) {
  if (!/^:\d{1,4}$/u.test(display ?? '')) throw new Error('Not an X display')
  return [display, '-screen', '0', screen, '-shmem', '-nolisten', 'tcp', '-nolisten', 'local', '-noreset']
}

/**
 * Keeps the box's X server running on `display` (from DISPLAY), started again a second after it ends. The Agent's
 * shell inherits DISPLAY, so a browser it starts opens on this screen. Without a display nothing starts.
 */
export function startDisplay({ display = process.env.DISPLAY, command = 'Xvfb', spawner = spawn, restartMs = 1000, log = () => {} } = {}) {
  if (!display) return { stop() {} }
  const args = displayArguments(display)
  let child = null, stopped = false, timer = null
  const run = () => {
    if (stopped) return
    child = spawner(command, args, { stdio: 'ignore', detached: false })
    child.on('error', () => log('box.display_unavailable'))
    child.on('exit', () => {
      child = null
      if (!stopped) timer = setTimeout(run, restartMs)
    })
  }
  run()
  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); child?.kill('SIGTERM') },
    get running() { return Boolean(child) },
  }
}

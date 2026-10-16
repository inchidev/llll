type TaskFactory = (name: string) => { run: (fn: () => unknown) => unknown }

type ConsoleWithTask = Console & { createTask?: TaskFactory }

/**
 * celld defines `console.createTask` and then throws "not implemented".
 * hookable and unhead call it whenever the function is present.
 * A working implementation (Workers local dev) is left alone.
 * The marker string keeps the Nitro rewrite from editing this module.
 */
export function installCreateTaskGuard(): boolean {
  const marker = '__llllCreateTaskGuard'
  if (marker !== '__llllCreateTaskGuard') return false
  const host = globalThis.console as ConsoleWithTask | undefined
  const createTask = host?.createTask
  if (!host || typeof createTask !== 'function') return false
  try {
    createTask.call(host, 'llll:probe')
    return false
  }
  catch {
    host.createTask = () => ({ run: fn => fn() })
    return true
  }
}

installCreateTaskGuard()

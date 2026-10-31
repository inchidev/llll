import type { L4Env } from '../../workers/env'

/**
 * Counts how many D1 round trips a call waits for one after another. Every statement, batch
 * or query waits `delayMs`; parallel ones overlap, so elapsed time over the delay is the chain length.
 */
export async function sequentialRoundTrips(env: L4Env, run: (env: L4Env) => Promise<unknown>, delayMs = 10) {
  const wait = () => new Promise(resolve => setTimeout(resolve, delayMs))
  const statement = (target: object): object => new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key)
      if (typeof value !== 'function') return value
      if (key === 'bind') return (...args: unknown[]) => statement(value.apply(object, args))
      if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') return async (...args: unknown[]) => { await wait(); return value.apply(object, args) }
      return value.bind(object)
    },
  })
  const db = new Proxy(env.DB as object, {
    get(object, key) {
      const value = Reflect.get(object, key)
      if (typeof value !== 'function') return value
      if (key === 'prepare') return (sql: string) => statement(value.call(object, sql))
      if (key === 'batch') return async (statements: unknown[]) => { await wait(); return value.call(object, statements) }
      return value.bind(object)
    },
  })
  const started = performance.now()
  await run({ ...env, DB: db } as L4Env)
  return Math.round((performance.now() - started) / delayMs)
}

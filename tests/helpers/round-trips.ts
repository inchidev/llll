import type { L4Env } from '../../workers/env'

/**
 * Counts how many D1 round trips a call waits for one after another. Every statement, batch
 * or query waits `delayMs`; parallel ones overlap, so each new round trip with none in flight
 * lengthens the chain. Counting rather than timing keeps the answer the same on a busy machine.
 */
export async function sequentialRoundTrips(env: L4Env, run: (env: L4Env) => Promise<unknown>, delayMs = 10) {
  let inFlight = 0, chain = 0
  const wait = async () => {
    if (inFlight++ === 0) chain++
    await new Promise(resolve => setTimeout(resolve, delayMs))
    inFlight--
  }
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
  await run({ ...env, DB: db } as L4Env)
  return chain
}

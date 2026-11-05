import { wrapsBinding } from '../../shared/binding-identity'
import type { L4Env } from '../../workers/env'

/**
 * Counts how many D1 round trips a call waits for one after another. Every statement, batch
 * or query waits `delayMs`; parallel ones overlap, so each new round trip with none in flight
 * lengthens the chain. Counting rather than timing keeps the answer the same on a busy machine.
 */
export async function sequentialRoundTrips(env: L4Env, run: (env: L4Env) => Promise<unknown>, delayMs = 10) {
  return (await measure(env, run, delayMs)).chain
}

/** Counts the requests a call makes to D1, parallel or not: a batch is one, however many statements it holds. */
export async function databaseRequests(env: L4Env, run: (env: L4Env) => Promise<unknown>) {
  return (await measure(env, run, 0)).requests
}

async function measure(env: L4Env, run: (env: L4Env) => Promise<unknown>, delayMs: number) {
  let inFlight = 0, chain = 0, requests = 0
  const wait = async () => {
    requests++
    if (inFlight++ === 0) chain++
    await new Promise(resolve => setTimeout(resolve, delayMs))
    inFlight--
  }
  // A batch takes the statements themselves: it is one round trip, however many it holds.
  const originals = new WeakMap<object, object>()
  const statement = (target: object): object => {
    const wrapped = new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key)
        if (typeof value !== 'function') return value
        if (key === 'bind') return (...args: unknown[]) => statement(value.apply(object, args))
        if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') return async (...args: unknown[]) => { await wait(); return value.apply(object, args) }
        return value.bind(object)
      },
    })
    originals.set(wrapped, target)
    return wrapped
  }
  const db = wrapsBinding(new Proxy(env.DB as object, {
    get(object, key) {
      const value = Reflect.get(object, key)
      if (typeof value !== 'function') return value
      if (key === 'prepare') return (sql: string) => statement(value.call(object, sql))
      if (key === 'batch') return async (statements: object[]) => { await wait(); return value.call(object, statements.map(item => originals.get(item) ?? item)) }
      return value.bind(object)
    },
  }), env.DB as object)
  await run({ ...env, DB: db } as L4Env)
  return { chain, requests }
}

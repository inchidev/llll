import type { L4Env } from '../../workers/env'

type Span = { count: number; ms: number }
type D1Meta = { duration?: number; served_by_region?: string; served_by_primary?: boolean }

/** The first request this isolate serves pays its cold start. */
let warm = false

/**
 * Per-request measurement of what a request waits on: each D1 statement and
 * Durable Object call is timed around its own promise. Callers get the original
 * statements, stubs and promises back, so RPC pipelining and D1 sessions behave as before.
 */
export function requestTiming(env: L4Env) {
  const cold = !warm
  warm = true
  const started = performance.now()
  const d1: Span & { sql: number; regions: Set<string> } = { count: 0, ms: 0, sql: 0, regions: new Set() }
  const objects: Span = { count: 0, ms: 0 }

  function observe<T>(span: Span, value: T, statements = 1): T {
    if (!value || typeof (value as { then?: unknown }).then !== 'function') return value
    const at = performance.now()
    span.count += statements
    const settle = (result?: unknown) => {
      span.ms += performance.now() - at
      if (span !== d1) return
      for (const item of Array.isArray(result) ? result : [result]) {
        const meta = (item as { meta?: D1Meta } | undefined)?.meta
        if (typeof meta?.duration === 'number') d1.sql += meta.duration
        if (meta?.served_by_region) d1.regions.add(`${meta.served_by_region}${meta.served_by_primary === false ? ' replica' : ''}`)
      }
    }
    ;(value as unknown as PromiseLike<unknown>).then(settle, () => settle())
    return value
  }

  // D1 batch takes its own statement objects, never these wrappers.
  const originals = new WeakMap<object, D1PreparedStatement>()
  function statement(target: D1PreparedStatement): D1PreparedStatement {
    const wrapped = new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key)
        if (typeof value !== 'function') return value
        if (key === 'bind') return (...args: unknown[]) => statement(value.apply(object, args))
        if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') return (...args: unknown[]) => observe(d1, value.apply(object, args))
        return value.bind(object)
      },
    })
    originals.set(wrapped, target)
    return wrapped
  }

  function database<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key)
        if (typeof value !== 'function') return value
        if (key === 'prepare') return (sql: string) => statement(value.call(object, sql))
        if (key === 'batch') return (statements: D1PreparedStatement[]) =>
          observe(d1, value.call(object, statements.map(item => originals.get(item) ?? item)), statements.length)
        if (key === 'exec') return (sql: string) => observe(d1, value.call(object, sql))
        if (key === 'withSession') return (...args: unknown[]) => database(value.apply(object, args))
        return value.bind(object)
      },
    })
  }

  function stub<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key)
        if (typeof value !== 'function' || key === 'then') return value
        return (...args: unknown[]) => observe(objects, value.apply(object, args))
      },
    })
  }

  function namespace<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key)
        if (typeof value !== 'function') return value
        if (key === 'get' || key === 'getByName') return (...args: unknown[]) => stub(value.apply(object, args))
        return value.bind(object)
      },
    })
  }

  const timed = { ...env } as Record<string, unknown>
  for (const [key, value] of Object.entries(env)) {
    if (key === 'DB' && value) timed[key] = database(value as object)
    else if (value && typeof (value as { idFromName?: unknown }).idFromName === 'function') timed[key] = namespace(value as object)
  }

  const ms = (value: number) => Math.round(value * 10) / 10
  return {
    env: timed as L4Env,
    /** A Server-Timing header value; D1 and Durable Object times are summed, so parallel calls overlap. */
    header() {
      const regions = [...d1.regions].join(', ')
      return [
        `d1;dur=${ms(d1.ms)};desc="${d1.count} statements${regions ? ` · ${regions}` : ''}"`,
        `d1-sql;dur=${ms(d1.sql)};desc="time inside D1"`,
        `do;dur=${ms(objects.ms)};desc="${objects.count} Durable Object calls"`,
        `app;dur=${ms(performance.now() - started)};desc="whole request"`,
        ...(cold ? ['cold;desc="first request in this isolate"'] : []),
      ].join(', ')
    },
    summary() {
      return { cold, d1: d1.count, d1Ms: ms(d1.ms), d1SqlMs: ms(d1.sql), d1Regions: [...d1.regions], doCalls: objects.count, doMs: ms(objects.ms), totalMs: ms(performance.now() - started) }
    },
  }
}

/**
 * Replacement for `node:timers` on runtimes whose `setImmediate` throws.
 *
 * This must stay a separate module. Inlining these `const` bindings into the
 * Worker entry makes celld fail to instantiate it (`instantiate: <none>`).
 * `setImmediate` is `setTimeout(fn, 0)`. The other timers are the globals.
 */
export const setImmediate = (callback, ...args) => globalThis.setTimeout(callback, 0, ...args)

export const clearImmediate = (handle) => {
  globalThis.clearTimeout(handle)
}

export const setTimeout = globalThis.setTimeout.bind(globalThis)
export const clearTimeout = globalThis.clearTimeout.bind(globalThis)
export const setInterval = globalThis.setInterval.bind(globalThis)
export const clearInterval = globalThis.clearInterval.bind(globalThis)

export const promises = {
  setTimeout(delay, value) {
    return new Promise((resolve) => {
      globalThis.setTimeout(() => resolve(value), delay ?? 0)
    })
  },
  setImmediate(value) {
    return new Promise((resolve) => {
      globalThis.setTimeout(() => resolve(value), 0)
    })
  },
  setInterval() {
    return Promise.reject(new Error('node:timers/promises setInterval is not available'))
  },
}

export default {
  setImmediate,
  clearImmediate,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  promises,
}

/** `node:timers/promises` without the runtime's throwing `setImmediate`. */
export const setTimeout = (delay, value) => new Promise((resolve) => {
  globalThis.setTimeout(() => resolve(value), delay ?? 0)
})

export const setImmediate = (value) => new Promise((resolve) => {
  globalThis.setTimeout(() => resolve(value), 0)
})

export const setInterval = () => Promise.reject(new Error('node:timers/promises setInterval is not available'))

export default { setTimeout, setImmediate, setInterval }

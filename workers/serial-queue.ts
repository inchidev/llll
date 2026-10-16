/**
 * Runs tasks one after another in the order they were queued. A failed task
 * does not stop the ones queued behind it.
 */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task)
    tail = run.catch(() => {})
    return run
  }
}

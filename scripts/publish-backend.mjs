import { resolve } from 'node:path'
import { cp, mkdir, readdir, rm, writeFile, rename } from 'node:fs/promises'

/** Serialize compiled hooks: parallel publications must not rename or remove
 * each other's marker, snapshots or retained build directories. */
export function createBackendPublisher(output, published) {
  let queue = Promise.resolve(), last = 0
  return () => {
    const next = queue.then(async () => {
      last = Math.max(Date.now(), last + 1)
      const directory = `build-${last}`
      await mkdir(published, { recursive: true })
      await cp(output, resolve(published, directory), { recursive: true })
      const marker = resolve(published, '.build.json')
      await writeFile(marker + '.tmp', JSON.stringify({ builtAt: new Date().toISOString(), directory }))
      await rename(marker + '.tmp', marker)
      const previous = (await readdir(published)).filter(name => /^build-\d+$/.test(name)).sort().slice(0, -5)
      for (const name of previous) await rm(resolve(published, name), { recursive: true })
      return directory
    })
    queue = next.catch(() => {})
    return next
  }
}

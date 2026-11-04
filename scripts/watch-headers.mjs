import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function createWatchHeadersPlugin(publicDir) {
  const path = join(publicDir, '_headers')
  const original = await readFile(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  return {
    name: 'llll-watch-headers',
    async buildStart() {
      // Nitro appends route rules to the existing file on every compiled hook.
      // Restore the input before each bundle, including failed-build recovery.
      if (original === undefined) await rm(path, { force: true })
      else await writeFile(path, original)
    },
  }
}

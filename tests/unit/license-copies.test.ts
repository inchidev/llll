import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Release artifacts carry these copies, so recipients get the terms with the software.
it.each(['public/LICENSE.txt', 'packages/deployment-core/LICENSE'])('%s matches LICENSE', path => {
  expect(readFileSync(path, 'utf8')).toBe(readFileSync('LICENSE', 'utf8'))
})

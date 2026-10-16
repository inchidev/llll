import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const examplePath = '.env.example'
const envPath = '.env'
const example = readFileSync(examplePath, 'utf8')
let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''

const assigned = new Set(
  env.split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1])
    .filter(Boolean),
)

const missing = example.split(/\r?\n/).filter((line) => {
  const key = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1]
  return key && !assigned.has(key)
})

if (missing.length) env = `${env.trimEnd()}${env.trim() ? '\n\n' : ''}${missing.join('\n')}\n`

const secret = randomBytes(32).toString('base64url')
if (/^AUTH_SECRET=(?:|replace-with-a-random-secret)$/m.test(env)) {
  env = env.replace(/^AUTH_SECRET=(?:|replace-with-a-random-secret)$/m, `AUTH_SECRET=${secret}`)
}
else if (!/^AUTH_SECRET=/m.test(env)) {
  env = `${env.trimEnd()}\nAUTH_SECRET=${secret}\n`
}

writeFileSync(envPath, env)
console.log(`Ready: ${envPath} (existing values preserved)`)

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

for (const name of ['AUTH_SECRET', 'SETUP_TOKEN']) {
  const secret = randomBytes(32).toString('base64url')
  const placeholder = new RegExp(`^${name}=(?:|replace-with-a-random-secret)$`, 'm')
  if (placeholder.test(env)) env = env.replace(placeholder, `${name}=${secret}`)
  else if (!new RegExp(`^${name}=`, 'm').test(env)) env = `${env.trimEnd()}\n${name}=${secret}\n`
}

writeFileSync(envPath, env, { mode: 0o600 })
console.log(`Ready: ${envPath} (existing values preserved)`)

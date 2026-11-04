import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { uiIcons } from '../../packages/client-ui/icons'

const phosphor = createRequire(import.meta.url)('@iconify-json/ph/icons.json') as { icons: Record<string, unknown>; aliases?: Record<string, unknown> }
const exists = (name: string) => name in phosphor.icons || name in (phosphor.aliases ?? {})

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? sources(path) : /\.(vue|ts)$/u.test(entry) ? [path] : []
  })
}

it('names only icons that exist: a Client asks no icon service, so a wrong name is blank', () => {
  const used = new Set(['app', 'packages/client-ui', 'shared'].flatMap(sources)
    .flatMap(file => [...readFileSync(file, 'utf8').matchAll(/i-ph-([a-z0-9-]*[a-z0-9])/gu)].map(match => match[1]!)))
  expect(used.size).toBeGreaterThan(100)
  expect([...used].filter(name => !exists(name))).toEqual([])
})

it('leaves none of the icons Nuxt UI draws to its default set', () => {
  expect(Object.values(uiIcons).filter(icon => !icon.startsWith('i-ph-'))).toEqual([])
})

it('bundles every icon and reaches no icon service', () => {
  const source = readFileSync('nuxt.config.ts', 'utf8')
  expect(source).toMatch(/provider: 'none'/u)
  expect(source).toMatch(/fallbackToApi: false/u)
})

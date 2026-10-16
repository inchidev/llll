import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const timersShim = fileURLToPath(new URL('./server/shims/node-timers.mjs', import.meta.url))
const timersPromisesShim = fileURLToPath(new URL('./server/shims/node-timers-promises.mjs', import.meta.url))
const timersShimSource = readFileSync(timersShim)
const timersPromisesShimSource = readFileSync(timersPromisesShim)

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const shimForSpecifier = [
  ['node:timers/promises', 'celld-timers-promises.mjs'],
  ['timers/promises', 'celld-timers-promises.mjs'],
  ['node:timers', 'celld-timers.mjs'],
  ['timers', 'celld-timers.mjs'],
]

/** Relative ESM path from an output chunk to a shim emitted beside the worker entry. */
export function relativeShimPath(fileName, shimName) {
  const normalized = fileName.replaceAll('\\', '/')
  const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : ''
  let relative = path.posix.relative(dir, shimName)
  if (!relative.startsWith('.')) relative = `./${relative}`
  return relative
}

/**
 * Point leftover `node:timers` imports at the raw shim module.
 * The Cloudflare preset can externalize this builtin after the alias plugin
 * runs. Rewriting the specifier keeps the binding in its own module: inlining
 * the consts into the worker entry makes celld fail with `instantiate: <none>`.
 */
export function rewriteNodeTimersImports(code, fileName) {
  let next = code
  const needed = new Set()
  for (const [specifier, shimName] of shimForSpecifier) {
    const relative = relativeShimPath(fileName, shimName)
    const pattern = new RegExp(
      `(?<=(?:from|import)\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)(["'])${escapeRegExp(specifier)}\\1`,
      'g',
    )
    next = next.replace(pattern, (_match, quote) => {
      needed.add(shimName)
      return `${quote}${relative}${quote}`
    })
  }
  return { code: next, needed }
}

/** Rewrite hookable/unhead so a throwing `console.createTask` is treated as absent. */
export function rewriteConsoleCreateTask(code) {
  if (!code.includes('createTask') || code.includes('__llllCreateTaskGuard')) return code
  return code
    .replace(/\b(?:globalThis\.)?console\??\.createTask\b/g, 'globalThis.__llllCreateTask')
    .replace(/\bconsole\[\s*["']createTask["']\s*\]/g, 'globalThis.__llllCreateTask')
}

export const llllNodeAliases = {
  'node:timers': timersShim,
  'node:timers/promises': timersPromisesShim,
}

export function llllNitroPlugins() {
  return [
    {
      name: 'llll-node-timers-shim',
      resolveId(source) {
        if (source === 'node:timers' || source === 'timers') return timersShim
        if (source === 'node:timers/promises' || source === 'timers/promises') return timersPromisesShim
        return null
      },
    },
    {
      name: 'llll-console-create-task',
      renderChunk(code) {
        const next = rewriteConsoleCreateTask(code)
        return next === code ? null : { code: next, map: null }
      },
    },
    {
      name: 'llll-external-node-timers',
      generateBundle(_options, bundle) {
        const needed = new Set()
        for (const item of Object.values(bundle)) {
          if (item.type !== 'chunk' || typeof item.code !== 'string') continue
          const rewritten = rewriteNodeTimersImports(item.code, item.fileName)
          if (rewritten.code === item.code) continue
          item.code = rewritten.code
          item.map = null
          for (const fileName of rewritten.needed) needed.add(fileName)
        }
        const sources = {
          'celld-timers.mjs': timersShimSource,
          'celld-timers-promises.mjs': timersPromisesShimSource,
        }
        for (const fileName of needed) {
          if (bundle[fileName]) continue
          this.emitFile({ type: 'asset', fileName, source: sources[fileName] })
        }
      },
    },
    {
      name: 'llll-runtime-chunks',
      outputOptions(options) {
        const previous = options.manualChunks
        return {
          ...options,
          experimentalMinChunkSize: 0,
          manualChunks(id, meta) {
            const normalized = id.replaceAll('\\', '/')
            if (normalized.includes('/server/shims/node-timers')) return 'node-timers-shim'
            if (normalized.includes('/server/shims/create-task-guard')) return 'create-task-guard'
            if (typeof previous === 'function') return previous(id, meta)
            return undefined
          },
        }
      },
    },
  ]
}

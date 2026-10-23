import { installerError } from './errors.js'
import type { InstallerReleaseManifest } from './types.js'

export type ExistingWorkerMigration = { exists: boolean, migrationTag?: string }

export function durableObjectMigrations(manifest: Pick<InstallerReleaseManifest, 'durableObjects' | 'durableObjectMigrations'>, worker: ExistingWorkerMigration) {
  const groups = new Map<string, string[]>()
  for (const item of manifest.durableObjects) groups.set(item.migration, [...groups.get(item.migration) || [], item.className])
  const steps = manifest.durableObjectMigrations?.map(({ tag, ...step }) => [tag, step] as const) ?? [...groups.entries()].map(([tag, new_sqlite_classes]) => [tag, { new_sqlite_classes }] as const)
  const latestTag = steps.at(-1)?.[0]
  if (!latestTag) installerError(502, 'L4 release has no Durable Object migrations')
  if (!worker.exists) return { new_tag: latestTag, steps: steps.map(([, step]) => step) }
  if (!worker.migrationTag) installerError(409, 'Existing L4 Worker has no migration tag')
  const currentIndex = steps.findIndex(([tag]) => tag === worker.migrationTag)
  if (currentIndex === -1) installerError(409, `Existing L4 migration ${worker.migrationTag} is not recognized`)
  const pending = steps.slice(currentIndex + 1)
  if (!pending.length) return undefined
  return {
    old_tag: worker.migrationTag,
    new_tag: latestTag,
    steps: pending.map(([, step]) => step),
  }
}

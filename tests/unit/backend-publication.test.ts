import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createBackendPublisher } from '../../scripts/publish-backend.mjs'

it('serializes overlapping publications and retains the completed marker target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'l4-publish-')), output = join(root, 'output'), target = join(root, 'published')
  try {
    await mkdir(output); await writeFile(join(output, 'index.mjs'), 'export default 42')
    const publish = createBackendPublisher(output, target)
    const directories = await Promise.all(Array.from({ length: 20 }, () => publish()))
    expect(new Set(directories).size).toBe(20)
    const marker = JSON.parse(await readFile(join(target, '.build.json'), 'utf8'))
    expect(marker.directory).toBe(directories.at(-1))
    expect(await readFile(join(target, marker.directory, 'index.mjs'), 'utf8')).toBe('export default 42')
    expect((await readdir(target)).filter(name => name.startsWith('build-'))).toHaveLength(5)
  } finally { await rm(root, { recursive: true, force: true }) }
})

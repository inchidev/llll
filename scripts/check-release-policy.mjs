import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { releasePlan } from './release-policy.mjs'

const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim()
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const libraryVersion = JSON.parse(readFileSync('packages/deployment-core/package.json', 'utf8')).version
const base = process.argv[2] || event.pull_request?.base.sha || event.merge_group?.base_sha || 'HEAD^'
const previous = JSON.parse(git(['show', `${base}:package.json`])).version
let pr = event.pull_request
if (!pr && version !== previous && process.env.GITHUB_EVENT_NAME === 'push') {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/commits/${process.env.GITHUB_SHA}/pulls`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error('Cannot verify the merged release PR')
  pr = (await response.json()).find(item => item.merged_at && item.base.ref === 'main' && item.merge_commit_sha === process.env.GITHUB_SHA)
}
const result = releasePlan({ previous, version, libraryVersion, releasePr: pr?.labels.some(label => label.name === 'release') || false, notesExist: existsSync(`docs/release-notes/v${version}.md`) })
console.log(result.release ? `Validated release PR for ${result.tag}` : 'Version unchanged: no release or production deployment')

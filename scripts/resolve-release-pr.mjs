import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { releasePlan } from './release-policy.mjs'

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
let pr = event.pull_request
if (!pr) {
  const number = Number(event.inputs?.pr)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Choose a merged release PR number')
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/pulls/${number}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error('Cannot read release PR')
  pr = await response.json()
}
if (!pr.merged && !pr.merged_at) throw new Error('The release PR must already be merged')
if (pr.base.ref !== 'main' || pr.base.repo.full_name !== process.env.GITHUB_REPOSITORY) throw new Error('Release PR must target this repository main')
const sha = pr.merge_commit_sha
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid merge commit')
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim()
git(['fetch', '--no-tags', '--depth=2', 'origin', sha])
const file = (revision, path) => JSON.parse(git(['show', `${revision}:${path}`]))
const version = file(sha, 'package.json').version
let notesExist = true
try { git(['cat-file', '-e', `${sha}:docs/release-notes/v${version}.md`]) } catch { notesExist = false }
const plan = releasePlan({ previous: file(`${sha}^`, 'package.json').version, version, libraryVersion: file(sha, 'packages/deployment-core/package.json').version, releasePr: pr.labels.some(label => label.name === 'release'), notesExist })
const dryRun = event.inputs?.dry_run === 'true' || event.inputs?.dry_run === true
for (const [key, value] of Object.entries({ eligible: plan.release && !dryRun, commit: sha, version, tag: `v${version}`, pr: pr.number })) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
console.log(plan.release ? `${dryRun ? 'Dry run: ' : ''}release PR #${pr.number}, v${version}, ${sha}` : 'Ordinary merge: release and production jobs skipped')

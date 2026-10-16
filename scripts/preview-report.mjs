import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const marker = '<!-- llll-worker-preview -->'

export function wranglerPreviewOutput(raw) {
  const entries = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      }
      catch {
        return []
      }
    })
  const preview = entries.reverse().find(entry => entry?.type === 'preview')
  if (!preview) throw new Error('Wrangler output did not contain a Preview result')
  return preview
}

export function previewDeployment(output) {
  const previewUrl = output.preview_urls?.[0] || output.preview?.urls?.[0]
  const deploymentUrl = output.deployment_urls?.[0] || output.deployment?.urls?.[0]
  if (!previewUrl || !deploymentUrl) {
    throw new Error('Cloudflare created the Preview without a URL. In llll-sandbox, open Domains > Worker URL and enable Preview, then rerun this job.')
  }
  return {
    previewName: output.preview_name || output.preview?.name,
    previewUrl,
    deploymentUrl,
    deploymentId: output.deployment_id || output.deployment?.id,
  }
}

export function previewComment(deployment, sha) {
  return `${marker}
## Worker Preview

- Latest PR Preview: ${deployment.previewUrl}
- Exact deployment: ${deployment.deploymentUrl}
- Commit: \`${sha}\`

This is a disposable environment with isolated D1, R2, KV, and Durable Object state. It is not a release.
`
}

function githubCoordinates() {
  const [owner, repo, extra] = (process.env.GITHUB_REPOSITORY || '').split('/')
  const prNumber = process.env.LLLL_PREVIEW_PR || ''
  if (!owner || !repo || extra || !/^[1-9][0-9]{0,9}$/.test(prNumber)) {
    throw new Error('GITHUB_REPOSITORY and LLLL_PREVIEW_PR must identify one pull request')
  }
  return { owner, repo, prNumber }
}

async function github(path, init = {}) {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required to update the Preview comment')
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error(`GitHub API ${init.method || 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

async function writeOutputs(deployment) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
  await appendFile(process.env.GITHUB_OUTPUT, `preview_url=${deployment.previewUrl}\ndeployment_url=${deployment.deploymentUrl}\n`)
}

async function upsertComment(deployment) {
  const { owner, repo, prNumber } = githubCoordinates()
  const body = previewComment(deployment, process.env.LLLL_PREVIEW_SHA || process.env.GITHUB_SHA || 'unknown')
  const comments = await github(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`)
  const existing = comments.find(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.includes(marker))
  if (existing) {
    await github(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
  }
  else {
    await github(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
  }
}

async function main() {
  const [command, file] = process.argv.slice(2)
  if (!file) throw new Error('Usage: preview-report.mjs <outputs|comment> <wrangler-output.ndjson>')
  const deployment = previewDeployment(wranglerPreviewOutput(await readFile(file, 'utf8')))
  if (command === 'outputs') return writeOutputs(deployment)
  if (command === 'comment') return upsertComment(deployment)
  throw new Error('Usage: preview-report.mjs <outputs|comment> <deployment.json>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

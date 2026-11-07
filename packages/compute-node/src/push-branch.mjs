import { resolve } from 'node:path'
import { git, hardenedEnv } from './review-diff.mjs'

const SHA = /^[a-f0-9]{40}$/u
/** A push that did not happen, with a reason safe to report: it never holds the push's credential. */
export class PushRefused extends Error {}
/**
 * Git's own words on a failed push, on one line: the porcelain status of the ref and what Git or the remote
 * said, with this push's credentials and any other authorization header taken out.
 */
export function pushFailure(error, secrets) {
  let said = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.split('\n').map(line => line.replace(/\p{Cc}+/gu, ' ').trim())
    .filter(line => line && line !== 'Done' && !/^(?:To |hint:)/u.test(line)).join(' | ')
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) said = said.split(secret).join('[redacted]')
  return said.replace(/\b(authorization:?\s*(?:bearer|basic|token)?)\s+\S+/giu, '$1 [redacted]').replace(/\/\/[^/@\s]+@/gu, '//[redacted]@').slice(0, 300)
}
/**
 * The trusted daemon's push of one approved commit, from its own copy on the scratch disk at /mirror, never
 * from the box. It runs in a throwaway container with the network and a short credential the box never sees:
 * a single-repository GitHub token, or the Server's capability for a Gitea push. It updates exactly
 * `<ref>` to `<sha>`, and only while the branch is still where this Task last published it.
 */
export async function pushBranch({ mirror = '/mirror/repo.git', remote, ref, sha, expectedOld, token, authorization }, { outbound = false } = {}) {
  const url = new URL(remote)
  const github = url.origin === 'https://github.com' && /^\/[\w.-]+\/[\w.-]+\.git$/u.test(url.pathname) && typeof token === 'string' && token.length >= 20
  const brokered = /^\/api\/compute-agent\/publish\/[a-f0-9-]{36}\.git$/u.test(url.pathname) && /^Bearer [a-f0-9]{64}$/u.test(authorization ?? '')
  // On Cloudflare the box's outbound Worker adds the credential to the one push it allows.
  const viaOutbound = outbound && /^\/[\w./-]+\.git$/u.test(url.pathname) && !url.pathname.includes('..')
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && process.env.LLLL_PUSH_INSECURE_LOCAL === '1')) || url.username || url.password || url.search || url.hash
    || !(github || brokered || viaOutbound) || !/^refs\/heads\/l4-agent\/[a-f0-9-]{36}$/u.test(ref) || !SHA.test(sha) || !(expectedOld === null || SHA.test(expectedOld))) throw new PushRefused('Invalid push')
  const basic = github ? Buffer.from('x-access-token:' + token).toString('base64') : null
  const header = viaOutbound ? null : github ? 'AUTHORIZATION: basic ' + basic : 'AUTHORIZATION: ' + authorization
  const env = hardenedEnv([['protocol.allow', 'never'], ['protocol.https.allow', 'always'], ['protocol.http.allow', process.env.LLLL_PUSH_INSECURE_LOCAL === '1' ? 'always' : 'never'],
    ...(header ? [[`http.${url.origin}/.extraheader`, header]] : []), ['http.followRedirects', 'false'], ['http.lowSpeedLimit', '1024'], ['http.lowSpeedTime', '30'], ['push.gpgSign', 'false']])
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'GIT_SSL_CAINFO']) if (process.env[key]) env[key] = process.env[key]
  try {
    await git(mirror, ['push', '--quiet', '--no-verify', '--porcelain', `--force-with-lease=${ref}:${expectedOld ?? ''}`, remote, `${sha}:${ref}`], { env, timeoutMs: 300000 })
  } catch (error) {
    throw new PushRefused(pushFailure(error, [token, basic, authorization, authorization?.replace(/^Bearer /u, '')]) || 'Git gave no reason')
  }
  return { ok: true }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const chunks = []; let size = 0
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 10000) throw new Error('Request limit'); chunks.push(chunk) }
    process.stdout.write(JSON.stringify(await pushBranch(JSON.parse(Buffer.concat(chunks).toString()))) + '\n')
  } catch (error) {
    // Only a reason this helper wrote is reported: another error could quote its input, credential included.
    process.stdout.write(JSON.stringify({ ok: false, message: error instanceof PushRefused ? error.message : 'The push could not start' }) + '\n')
    process.exitCode = 1
  }
}

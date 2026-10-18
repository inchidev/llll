export function requireWorkersBuild(env = process.env) {
  if (env.CI !== 'true' || env.WORKERS_CI !== '1' || !env.WORKERS_CI_BUILD_UUID) {
    throw new Error('Cloud deployment is only allowed in Cloudflare Workers Builds. Open a PR; never deploy from this machine.')
  }
}

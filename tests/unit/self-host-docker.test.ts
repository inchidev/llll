import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('self-host docker stack', () => {
  it('builds L4 with a 6144 MiB heap and runs celld 0.6.3', () => {
    const dockerfile = read('self-host/Dockerfile')
    expect(dockerfile).toContain('NODE_OPTIONS=--max-old-space-size=6144')
    expect(dockerfile).toContain('ARG CELLD_VERSION=0.6.3')
    expect(dockerfile).toContain('ghcr.io/denoland/celld:${CELLD_VERSION}')
    expect(dockerfile).toContain('self-host/entrypoint.sh')
    expect(dockerfile).toContain('self-host/healthcheck.sh')
    expect(dockerfile).toContain('llll-healthcheck')
  })

  it('deploys, starts the node, then applies D1 migrations by database name', () => {
    const entrypoint = read('self-host/entrypoint.sh')
    const deploy = entrypoint.indexOf('celld deploy "$CONFIG"')
    const listen = entrypoint.indexOf('--listen "$CELLD_LISTEN"')
    const migrations = entrypoint.indexOf('celld d1 migrations apply "$DATABASE_NAME"')
    expect(deploy).toBeGreaterThan(-1)
    expect(listen).toBeGreaterThan(deploy)
    expect(migrations).toBeGreaterThan(listen)
    expect(entrypoint).toContain('chmod 600')
    expect(entrypoint).toContain('CELLD_RESTART_DELAY')
    expect(entrypoint).toContain('.migrations-applied')
    expect(entrypoint).not.toContain('CELLD_VARS_FILE')
  })

  it('composes RustFS, bucket init, healthchecks, and restart always', () => {
    const compose = read('self-host/docker-compose.yml')
    expect(compose).toMatch(/image: rustfs\/rustfs:\d+\.\d+\.\d+/)
    expect(compose).toContain('bucket-init:')
    expect(compose).toContain('restart: always')
    expect(compose).toContain('llll-healthcheck')
    expect(read('self-host/healthcheck.sh')).toContain('/api/setup/health')
    expect(read('self-host/healthcheck.sh')).toContain('.migrations-applied')
    expect(compose).toContain('s3://${RUSTFS_BUCKET:-cells}')
    expect(compose).toContain('CELLD_DURABILITY: bucket')
  })

  it('keeps the env example to placeholders', () => {
    const example = read('self-host/.env.example')
    for (const key of [
      'PUBLIC_ORIGIN',
      'AUTH_SECRET',
      'ADMIN_EMAIL',
      'SETUP_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'AI_BASE_URL',
      'AI_API_KEY',
      'AI_MODEL',
      'MAIL_GATEWAY_URL',
      'INBOUND_EMAIL_SECRET',
      'BROWSER_CDP_URL',
    ]) {
      expect(example).toContain(key)
    }
    expect(example).not.toMatch(/sk_live|price_|acct_|whsec_/)
    expect(example).not.toMatch(/[0-9a-f]{32}/i)
    expect(read('wrangler.celld.json')).toContain('"AUTH_SECRET": "invalid"')
  })

  it('drafts a Coolify service with generated URL and password variables', () => {
    const template = read('self-host/coolify/docker-compose.yaml')
    expect(template).toContain('SERVICE_URL_LLLL_8080')
    expect(template).toContain('SERVICE_FQDN_LLLL_8080')
    expect(template).toContain('SERVICE_PASSWORD_64_AUTHSECRET')
    expect(template).toContain('SERVICE_PASSWORD_64_SETUPTOKEN')
    expect(template).toContain('SERVICE_USER_RUSTFS')
    expect(template).toContain('SERVICE_PASSWORD_64_RUSTFS')
    expect(template).toContain('# logo: svgs/llll.png')
  })

  it('drops the container port Coolify appends to the generated URL', () => {
    const entrypoint = read('self-host/entrypoint.sh')
    expect(entrypoint).toContain('PUBLIC_ORIGIN=${PUBLIC_ORIGIN%:8080}')
    expect(entrypoint.indexOf('PUBLIC_ORIGIN=${PUBLIC_ORIGIN%:8080}')).toBeLessThan(entrypoint.indexOf('put_var PUBLIC_ORIGIN'))
  })

  it('runs the published image in Coolify, updated by its tag', () => {
    const template = read('self-host/coolify/docker-compose.yaml')
    expect(template).toContain('image: ghcr.io/inchidev/llll:${LLLL_VERSION:-latest}')
    expect(template).not.toContain('pull_policy: never')
    expect(template.match(/restart: always/g)).toHaveLength(2)
    expect(template).toContain('LLLL_ORIGINS=${LLLL_ORIGINS:-}')
  })

  it('refuses an image older than the release that migrated the data', () => {
    const entrypoint = read('self-host/entrypoint.sh')
    const guard = entrypoint.indexOf('version_older "$IMAGE_VERSION" "$DATA_VERSION"')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(entrypoint.indexOf('celld deploy "$CONFIG"'))
    expect(entrypoint.indexOf('> "$DATA_VERSION_FILE"')).toBeGreaterThan(entrypoint.indexOf('touch "${CELLD_WATCH}/.migrations-applied"'))
    const dockerfile = read('self-host/Dockerfile')
    expect(dockerfile).toContain('FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build')
    expect(dockerfile).toContain('COPY --from=build /src/.llll-version /opt/llll/VERSION')
  })

  it('publishes only stable releases to GHCR for amd64 and arm64', () => {
    const workflow = read('.github/workflows/release.yml')
    const step = workflow.slice(workflow.indexOf('- name: Publish the stable Server image'))
    expect(step).toMatch(/^- name: Publish the stable Server image\n\s+if: \$\{\{ !contains\(env.RELEASE_VERSION, '-'\) \}\}/)
    expect(step).toContain('--platform linux/amd64,linux/arm64 --push')
    expect(step).toContain('is already published')
    expect(workflow).toContain('packages: write')
  })
})

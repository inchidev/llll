/// <reference types="@cloudflare/workers-types" />
import type { L4Env } from '../workers/env'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface CloudflareBindings extends L4Env {}
}

export {}

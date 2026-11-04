/// <reference types="@cloudflare/workers-types" />
export {}
declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import('../workers/index')
    }
  }
}

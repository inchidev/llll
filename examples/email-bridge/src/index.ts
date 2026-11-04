import { forwardInboundEmail, type EmailBridgeMessage } from '../../../workers/email-bridge'

export interface Env {
  LLLL_INBOUND_URL: string
  INBOUND_EMAIL_SECRET: string
}

/**
 * Cloudflare Email Routing bridge. Setup and the deploy directory are in ./README.md.
 * `INBOUND_EMAIL_SECRET` is a Worker secret, not a var in wrangler.jsonc.
 */
export default {
  async email(message: EmailBridgeMessage, env: Env): Promise<void> {
    await forwardInboundEmail(message, env)
  },
}

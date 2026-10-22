import type { L4Env } from './env'
import { receiveServerEmail } from './mail-ingress'
import { readServerMailDomains } from '../server/utils/server-mail'

/** Inbound mail belongs only to this Server's explicitly configured domains. */
export async function routeServerEmail(message: ForwardableEmailMessage, env: L4Env): Promise<void> {
  const domain = message.to.slice(message.to.lastIndexOf('@') + 1).trim().toLowerCase()
  if (!domain || !(await readServerMailDomains(env)).some(item => item.domain === domain)) {
    message.setReject('Unknown L4 mail domain')
    return
  }
  await receiveServerEmail(message, env)
}

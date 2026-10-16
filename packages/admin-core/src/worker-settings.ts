import { cloudflareApi } from './cloudflare-client.js'

export function workerSettingsForm(bindings: Array<Record<string, unknown>>) {
  const form = new FormData()
  form.append('settings', JSON.stringify({ bindings }))
  return form
}

export async function patchWorkerBindings(
  accessToken: string,
  accountId: string,
  workerName: string,
  bindings: Array<Record<string, unknown>>,
) {
  return cloudflareApi(accessToken, `/accounts/${accountId}/workers/scripts/${workerName}/settings`, {
    method: 'PATCH',
    body: workerSettingsForm(bindings),
  })
}

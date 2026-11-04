import { applyInlineScriptHashes } from '../utils/csp-script-hashes'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('beforeResponse', async (event, response) => {
    await applyInlineScriptHashes(event, response.body)
  })
})

/** Render the executable assignment, keeping lint directives out of substitution. */
export function renderPublicServiceWorker(template, cacheId, assets) {
  const assignment = 'const ASSETS = __PUBLIC_ASSETS__'
  if (!template.includes(assignment)) throw new Error('PWA asset assignment is missing')
  return template.replace('__CACHE_ID__', cacheId).replace(assignment, `const ASSETS = ${JSON.stringify(assets)}`)
}

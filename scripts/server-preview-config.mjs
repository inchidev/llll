/** Native Previews resolve bindings from previews, independently of the base Worker. */
export function isolatedPreviewBindings(config) {
  return {
    ...config.previews,
    vars: { ...config.vars },
    d1_databases: config.d1_databases,
    r2_buckets: config.r2_buckets,
    kv_namespaces: config.kv_namespaces,
    durable_objects: config.durable_objects,
  }
}

/** Use Cloudflare's assigned URL rather than guessing its Preview slug. */
export function nativeServerPreviewOrigin(preview) {
  for (const value of preview.urls || []) {
    try {
      const url = new URL(value)
      if (url.protocol === 'https:' && url.hostname.endsWith('.server-preview.llll.gg') && !url.username && !url.password)
        return url.origin
    }
    catch { /* Another returned URL may be usable. */ }
  }
  throw new Error('The staging Server needs its shared custom Preview domain')
}

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

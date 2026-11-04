const originals = new WeakMap<object, object>()

/** Records that a per-request wrapper stands for a long-lived binding. */
export function wrapsBinding<T extends object>(wrapper: T, original: object): T {
  originals.set(wrapper, originals.get(original) ?? original)
  return wrapper
}

/** The long-lived binding behind a wrapper, so per-isolate caches keep their hits. */
export function bindingIdentity<T extends object>(binding: T): T {
  return (originals.get(binding) ?? binding) as T
}

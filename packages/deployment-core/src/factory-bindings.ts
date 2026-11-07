/** Script-metadata container entry. Default scheduling reads image, size and how many boxes may run from here. */
export function factoryScriptContainer(workerName: string, image: string, instanceType: string, maxBoxes: number) {
  return { class_name: 'FactoryComputeDurableObject', name: `${workerName}-factory`, image, instance_type: instanceType, max_instances: maxBoxes }
}

/** Boxes a newly provisioned Server may run at once on its Cloudflare account. One container is one Task's box. */
export const FACTORY_DEFAULT_BOXES = 4
/** A policy written before boxes ran one container, so it keeps one until Factory is provisioned again. */
export function factoryMaxBoxes(policyText?: string) {
  try {
    const boxes = policyText ? (JSON.parse(policyText) as { maxBoxes?: number }).maxBoxes : undefined
    if (Number.isInteger(boxes) && boxes! >= 1 && boxes! <= 64) return boxes!
  } catch { /* Stale or absent policy text keeps one container. */ }
  return 1
}

export type FactoryApplicationConfiguration = {
  image: string
  instance_type?: string
  vcpu?: number
  memory_mib?: number
  disk?: { size_mb?: number }
}

/** Containers can return either the named size or its expanded resource values. */
export function factoryApplicationSizeMatches(configuration: FactoryApplicationConfiguration, size: { instance_type: string; cpu: number; memoryMiB: number; diskBytes: number }) {
  const expanded = configuration.vcpu !== undefined || configuration.memory_mib !== undefined || configuration.disk !== undefined
  if (configuration.instance_type !== undefined && configuration.instance_type !== size.instance_type) return false
  if (expanded) return configuration.vcpu === size.cpu
    && configuration.memory_mib === size.memoryMiB
    && configuration.disk?.size_mb === size.diskBytes / 1000000
  return configuration.instance_type === size.instance_type
}

export function factoryInstanceType(policyText?: string) {
  try {
    const cpu = policyText ? (JSON.parse(policyText) as { cpu?: number }).cpu : undefined
    if (cpu === 0.25) return 'basic'
    if (cpu === 1) return 'standard-2'
  } catch { /* Keep the reviewed standard size when policy text is absent or stale. */ }
  return 'standard-1'
}

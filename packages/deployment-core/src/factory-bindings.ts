/** Script-metadata container entry. Default scheduling reads image and size from here. */
export function factoryScriptContainer(workerName: string, image: string, instanceType: string) {
  return { class_name: 'FactoryComputeDurableObject', name: `${workerName}-factory`, image, instance_type: instanceType, max_instances: 1 }
}

export function factoryInstanceType(policyText?: string) {
  try {
    const cpu = policyText ? (JSON.parse(policyText) as { cpu?: number }).cpu : undefined
    if (cpu === 0.25) return 'basic'
    if (cpu === 1) return 'standard-2'
  } catch { /* Keep the reviewed standard size when policy text is absent or stale. */ }
  return 'standard-1'
}

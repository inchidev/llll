import { expect, it } from 'vitest'
import { factoryApplicationSizeMatches } from '../../packages/deployment-core/src/factory-bindings'

const size = { instance_type: 'basic', cpu: 0.25, memoryMiB: 1024, diskBytes: 4000000000 }
const observed = { image: 'released-image', vcpu: 0.25, memory_mib: 1024, disk: { size_mb: 4000 } }

it('recognizes the expanded Small configuration returned by the live Containers API', () => {
  expect(factoryApplicationSizeMatches(observed, size)).toBe(true)
  expect(factoryApplicationSizeMatches({ image: observed.image, instance_type: 'basic' }, size)).toBe(true)
})

it.each([
  { ...observed, vcpu: 0.5 },
  { ...observed, memory_mib: 4096 },
  { ...observed, disk: { size_mb: 4096 } },
  { ...observed, instance_type: 'standard-1' },
  { ...observed, memory_mib: undefined },
  { image: observed.image },
  { image: observed.image, instance_type: 'basic', vcpu: 0.5 },
])('rejects a different, contradictory or incomplete provider size: %j', configuration => {
  expect(factoryApplicationSizeMatches(configuration, size)).toBe(false)
})

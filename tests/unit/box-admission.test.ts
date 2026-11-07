import { describe, expect, it } from 'vitest'
import { admitBoxes, boxReservation } from '../../server/utils/box-admission'
import { cloudflareCapabilities, dockerCapabilities } from '../../shared/software-factory'
// @ts-expect-error The Node daemon is plain JavaScript without declarations.
import { nodeCapacity } from '../../packages/compute-node/src/capacity.mjs'

const GiB = 1073741824
const image = 'sha256:' + 'a'.repeat(64)

describe('Node capacity', () => {
  it('admits four Tasks at once on a 4-vCPU VPS and queues the fifth', () => {
    const capacity = nodeCapacity({}, { cpu: 4, memoryBytes: 16 * GiB })
    expect(capacity).toEqual({ cpu: 4, memoryMiB: 16384, boxes: 4 })
    const tasks = ['a', 'b', 'c', 'd', 'e']
    const { admitted, queued, reservation } = admitBoxes(capacity, [], tasks)
    expect(admitted).toEqual(['a', 'b', 'c', 'd'])
    expect(queued).toEqual(['e'])
    expect(reservation).toEqual({ cpu: 1, memoryMiB: 4096 })
    // The fifth starts as soon as one of the four stops.
    expect(admitBoxes(capacity, Array(3).fill(reservation), ['e']).admitted).toEqual(['e'])
  })

  it('lets the operator set the boxes and keeps 1 GiB per box by default', () => {
    expect(nodeCapacity({ LLLL_NODE_BOXES: '8' }, { cpu: 4, memoryBytes: 16 * GiB }).boxes).toBe(8)
    expect(nodeCapacity({}, { cpu: 8, memoryBytes: 2 * GiB }).boxes).toBe(2)
    expect(nodeCapacity({}, { cpu: 1, memoryBytes: 512 * 1048576 }).boxes).toBe(1)
    for (const value of ['0', '1.5', 'many', '65']) expect(() => nodeCapacity({ LLLL_NODE_BOXES: value }, { cpu: 4, memoryBytes: 16 * GiB })).toThrow('LLLL_NODE_BOXES')
  })

  it('counts what running boxes were admitted with when a Node reports less, and never lets a later Task overtake', () => {
    const before = { cpu: 4, memoryMiB: 16384, boxes: 4 }
    const running = [boxReservation(before), boxReservation(before)]
    // Same boxes, half the CPU: the two running boxes already hold 2 of 2 CPUs.
    expect(admitBoxes({ cpu: 2, memoryMiB: 16384, boxes: 4 }, running, ['next']).admitted).toEqual([])
    // Memory is a limit too.
    expect(admitBoxes({ cpu: 4, memoryMiB: 8192, boxes: 4 }, running, ['next', 'later']).queued).toEqual(['next', 'later'])
  })

  it('reserves one container per box on Cloudflare and announces capacity in protocol 2 only', () => {
    const container = { cpu: 0.25, memoryMiB: 1024 }
    const capacity = { cpu: container.cpu * 4, memoryMiB: container.memoryMiB * 4, boxes: 4 }
    expect(boxReservation(capacity)).toEqual(container)
    expect(admitBoxes(capacity, [], [1, 2, 3, 4, 5]).admitted).toEqual([1, 2, 3, 4])
    expect(cloudflareCapabilities.safeParse({ provider: 'cloudflare-containers', diskBytes: 4000000000, docker: false, durableDisk: false, isolation: 'container-vm',
      image: 'registry.cloudflare.com/a/f@' + image, capacity, protocol: 2, ...container, processLimit: 128, codeBytes: 500000000, timeoutMs: 120000 }).success).toBe(true)
    const docker = { diskBytes: 10 * GiB, docker: true, durableDisk: true, isolation: 'shared-kernel', image }
    expect(dockerCapabilities.safeParse({ ...docker, capacity: { cpu: 4, memoryMiB: 16384, boxes: 4 }, protocol: 2 }).success).toBe(true)
    // A protocol 1 Node ran one operation at a time; it is not accepted.
    expect(dockerCapabilities.safeParse({ ...docker, maxParallel: 1, protocol: 1 }).success).toBe(false)
  })
})

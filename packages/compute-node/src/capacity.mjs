import { availableParallelism, totalmem } from 'node:os'

/**
 * What this Node announces it can run at once. CPU and memory are the host's own (what `nproc` and
 * /proc/meminfo report); the Server reserves an equal share of them per box. Boxes default to one per
 * CPU while each still gets 1 GiB; LLLL_NODE_BOXES overrides it, for a host that also serves other work.
 */
export function nodeCapacity(env = process.env, host = { cpu: availableParallelism(), memoryBytes: totalmem() }) {
  const cpu = Math.max(1, Math.floor(host.cpu)), memoryMiB = Math.floor(host.memoryBytes / 1048576)
  if (memoryMiB < 256) throw new Error('This host has too little memory for a box')
  const configured = env.LLLL_NODE_BOXES
  const boxes = configured === undefined || configured === '' ? Math.max(1, Math.min(cpu, Math.floor(memoryMiB / 1024))) : Number(configured)
  if (!Number.isInteger(boxes) || boxes < 1 || boxes > 64) throw new Error('LLLL_NODE_BOXES must be a whole number from 1 to 64')
  return { cpu, memoryMiB, boxes }
}

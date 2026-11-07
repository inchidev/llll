import type { NodeCapacity } from '../../shared/software-factory'

/** The turn detail of a Task whose box waits for room on its Node. */
export const BOX_WAITING_DETAIL = 'Waiting for a free box'
export type BoxReservation = { cpu: number; memoryMiB: number }

/** A box holds an equal share of its Node. On Cloudflare that share is exactly one container's size. */
export function boxReservation(capacity: NodeCapacity): BoxReservation {
  return { cpu: capacity.cpu / capacity.boxes, memoryMiB: Math.floor(capacity.memoryMiB / capacity.boxes) }
}

/**
 * Admits waiting boxes in order while the Node has a free box and their CPU and memory fit beside the
 * active ones. An active box keeps the reservation it was admitted with, so a Node that now reports less
 * starts fewer boxes until older ones stop. The first box that does not fit ends admission: a later Task
 * never overtakes an earlier one.
 */
export function admitBoxes<T>(capacity: NodeCapacity, active: readonly BoxReservation[], waiting: readonly T[]) {
  const reservation = boxReservation(capacity)
  // Shares such as 0.25 CPU add up with rounding error; a hair of slack keeps the last one admitted.
  const slack = 1e-9
  let boxes = active.length, cpu = active.reduce((total, box) => total + box.cpu, 0), memoryMiB = active.reduce((total, box) => total + box.memoryMiB, 0)
  const admitted: T[] = []
  for (const box of waiting) {
    if (boxes >= capacity.boxes || cpu + reservation.cpu > capacity.cpu + slack || memoryMiB + reservation.memoryMiB > capacity.memoryMiB) break
    admitted.push(box)
    boxes++; cpu += reservation.cpu; memoryMiB += reservation.memoryMiB
  }
  return { reservation, admitted, queued: waiting.slice(admitted.length) }
}

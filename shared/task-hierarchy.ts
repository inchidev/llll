/** Iterative traversal also tolerates incomplete lists and legacy corrupt cycles. */
export function taskDescendants(tasks: ReadonlyArray<{ id: string; parentTaskId?: string | null }>, id: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const task of tasks) {
    if (!task.parentTaskId) continue
    const siblings = children.get(task.parentTaskId) ?? []
    siblings.push(task.id)
    children.set(task.parentTaskId, siblings)
  }
  const result = new Set<string>([id])
  const pending = [id]
  while (pending.length) {
    for (const child of children.get(pending.pop()!) ?? []) {
      if (result.has(child)) continue
      result.add(child)
      pending.push(child)
    }
  }
  return result
}

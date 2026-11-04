type BoardLike = { id: string; archivedAt?: string | null }

/** The live board order with one board moved past its neighbour. The route takes every live board in the Space. */
export function boardOrderAfterMove<B extends BoardLike>(boards: readonly B[], boardId: string, direction: -1 | 1): string[] | null {
  const live = boards.filter(board => !board.archivedAt)
  const board = live.find(item => item.id === boardId)
  if (!board) return null
  const neighbour = live[live.indexOf(board) + direction]
  if (!neighbour) return null
  return live.map(item => item.id === board.id ? neighbour.id : item.id === neighbour.id ? board.id : item.id)
}

type TaskLike = { assigneeId: string | null; createdBy: string; status: string; archivedAt?: string | null }

/** The same rule as the Inbox: what is assigned and open, and what you asked for that now waits on your review. */
export function myTasks<B extends BoardLike & { tasks: readonly TaskLike[] }>(boards: readonly B[], userId: string | null | undefined): { assigned: Array<{ task: B['tasks'][number]; board: B }>; review: Array<{ task: B['tasks'][number]; board: B }> } {
  const all = boards.filter(board => !board.archivedAt).flatMap(board => board.tasks.filter(task => !task.archivedAt).map(task => ({ task, board })))
  return {
    assigned: all.filter(({ task }) => task.assigneeId === userId && !['done', 'review'].includes(task.status)),
    review: all.filter(({ task }) => task.status === 'review' && task.createdBy === userId && task.assigneeId !== userId),
  }
}

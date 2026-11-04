import { describe, expect, it } from 'vitest'
import { boardOrderAfterMove, myTasks } from '../../shared/project-navigation'
import { breadcrumbTrail, spaceInitials, spacesWaiting } from '../../app/utils/spaces'

const board = (id: string, extra = {}) => ({ id, archivedAt: null as string | null, ...extra })

describe('moving a board', () => {
  const boards = [board('a'), board('old', { archivedAt: '2026-01-01' }), board('b'), board('c')]
  it('moves past the neighbour and keeps every live board in the request', () => {
    expect(boardOrderAfterMove(boards, 'c', -1)).toEqual(['a', 'c', 'b'])
  })
  it('has nowhere to go at either end', () => {
    expect(boardOrderAfterMove(boards, 'c', 1)).toBeNull()
    expect(boardOrderAfterMove(boards, 'a', -1)).toBeNull()
  })
})

describe('My tasks', () => {
  const task = (id: string, extra = {}) => ({ id, assigneeId: 'me', createdBy: 'other', status: 'ready', archivedAt: null, ...extra })
  const boards = [{ ...board('live'), tasks: [
    task('open'), task('failed', { status: 'failed' }), task('done', { status: 'done' }), task('gone', { archivedAt: 'x' }), task('theirs', { assigneeId: 'other' }),
    task('to-review', { assigneeId: 'other', createdBy: 'me', status: 'review' }), task('own-review', { createdBy: 'me', status: 'review' }),
  ] }, { ...board('old', { archivedAt: 'x' }), tasks: [task('on-archived-board')] }]
  it('holds what is assigned and open, and what waits on your review', () => {
    const { assigned, review } = myTasks(boards, 'me')
    expect(assigned.map(row => row.task.id)).toEqual(['open', 'failed'])
    expect(review.map(row => row.task.id)).toEqual(['to-review'])
  })
})

describe('breadcrumbs', () => {
  it('names the Space only for someone with more than one', () => {
    expect(breadcrumbTrail(null, [{ label: 'Data' }])).toEqual([{ label: 'Data' }])
    expect(breadcrumbTrail('Sales', [{ label: 'Pipeline' }, { label: 'Deals' }]).map(crumb => crumb.label)).toEqual(['Sales', 'Pipeline', 'Deals'])
  })
})

describe('Space switcher', () => {
  it('points at other Spaces, never the one on screen', () => {
    expect([...spacesWaiting(['a', 'b'], 'a')]).toEqual(['b'])
    expect(spacesWaiting(undefined, 'a').size).toBe(0)
  })
  it('draws up to two letters', () => {
    expect(spaceInitials('Sales')).toBe('S')
    expect(spaceInitials('field sales team')).toBe('FS')
    expect(spaceInitials('')).toBe('?')
  })
})

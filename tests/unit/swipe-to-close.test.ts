import { describe, expect, it } from 'vitest'
import { swipeCloses } from '../../app/composables/useSwipeToClose'

describe('swiping a panel closed', () => {
  it('closes past a third of its width', () => {
    expect(swipeCloses(140, 0.1, 400)).toBe(true)
    expect(swipeCloses(100, 0.1, 400)).toBe(false)
  })
  it('follows a flick over the distance', () => {
    expect(swipeCloses(40, 0.8, 400)).toBe(true)
    expect(swipeCloses(200, -0.8, 400)).toBe(false)
  })
})

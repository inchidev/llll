import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('page overscroll', () => {
  it('stops iOS dragging the Client page', () => {
    expect(read('app/assets/css/main.css')).toMatch(/html, body \{\s*overscroll-behavior: none;/)
  })

})

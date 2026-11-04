// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { mountRail } from '../../packages/native-shell/rail'
import { lastServerKey } from '../../packages/native-shell/server-list'

const servers = [
  { origin: 'https://one.example', id: '1', name: 'One' },
  { origin: 'https://two.example', id: '2', name: 'Two', iconUrl: 'https://two.example/icon.png' },
]
const host = () => ({ open: vi.fn(), showList: vi.fn(), ready: vi.fn() })
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.server')]

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('llll.native.servers', JSON.stringify(servers))
  document.body.innerHTML = '<button id="list"></button><ul id="servers"></ul><button id="add"></button>'
})

it('shows the device list and says when it is up', () => {
  const app = host()
  mountRail(app)
  expect(buttons().map(button => button.getAttribute('aria-label'))).toEqual(['One', 'Two'])
  expect(buttons()[0]!.textContent).toBe('O')
  expect(buttons()[1]!.querySelector('img')!.getAttribute('src')).toBe('https://two.example/icon.png')
  expect(app.ready).toHaveBeenCalledOnce()
})

it('marks the Server on screen, opens another, and remembers it for the next launch', () => {
  const app = host()
  mountRail(app)
  window.__L4_RAIL__!.setActive('https://one.example')
  expect(buttons()[0]!.getAttribute('aria-current')).toBe('page')
  buttons()[0]!.click()
  expect(app.open).not.toHaveBeenCalled()
  buttons()[1]!.click()
  expect(app.open).toHaveBeenCalledWith('https://two.example')
  expect(localStorage.getItem(lastServerKey)).toBe('https://two.example')
})

it('leads to the list for all Servers and for adding one', () => {
  const app = host()
  mountRail(app)
  document.querySelector<HTMLButtonElement>('#list')!.click()
  document.querySelector<HTMLButtonElement>('#add')!.click()
  expect(app.showList).toHaveBeenCalledTimes(2)
})

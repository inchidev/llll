import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { displayArguments, startDisplay } from '../src/display.mjs'

test('the box screen is Xvfb on the given display, its framebuffer in shared memory, with no network listener', () => {
  assert.deepEqual(displayArguments(':99'), [':99', '-screen', '0', '1280x720x24', '-shmem', '-nolisten', 'tcp', '-nolisten', 'local', '-noreset'])
  for (const bad of ['', '99', ':99;rm', 'host:0']) assert.throws(() => displayArguments(bad))
})

test('the screen starts again after it ends, stops for good when asked, and does not start without a display', async () => {
  const spawned = []
  const spawner = (command, args) => { const child = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; this.emit('exit') } }); spawned.push({ command, args, child }); return child }
  assert.equal(startDisplay({ display: '', spawner }).running, undefined)
  assert.equal(spawned.length, 0)
  const display = startDisplay({ display: ':99', spawner, restartMs: 5 })
  assert.equal(spawned.length, 1)
  assert.deepEqual(spawned[0].command, 'Xvfb')
  assert.equal(display.running, true)
  spawned[0].child.emit('exit')
  assert.equal(display.running, false)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(spawned.length, 2)
  display.stop()
  assert.equal(spawned[1].child.killed, true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(spawned.length, 2)
})

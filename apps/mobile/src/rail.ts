import { mountRail } from '../../../packages/native-shell/rail'

// Each app gives this page one channel of its own, which no Server's page has.
type Channel = { postMessage: (message: string) => void }
const channel = (window as unknown as { l4Rail?: Channel }).l4Rail
  ?? (window as unknown as { webkit?: { messageHandlers?: { l4Rail?: Channel } } }).webkit?.messageHandlers?.l4Rail
const send = (message: object) => channel?.postMessage(JSON.stringify(message))

mountRail({
  open: origin => send({ type: 'open', origin }),
  showList: () => send({ type: 'list' }),
  ready: () => send({ type: 'ready' }),
})

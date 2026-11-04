import { Capacitor } from '@capacitor/core'
import { mountMarker, toBase64 } from '../../../packages/native-shell/mark'
import type { RecordingLimitsDTO, RecordingSaid } from '../../../shared/task-recordings'
import { L4Share } from './share-plugin'

void mountMarker({
  async share() {
    const pending = await L4Share.pendingShare()
    if (!pending.path) return null
    const blob = await (await fetch(Capacitor.convertFileSrc(pending.path))).blob()
    return { file: new File([blob], pending.name!, { type: blob.type }), servers: pending.servers ?? [], origin: pending.origin ?? null }
  },
  limits: async origin => JSON.parse((await L4Share.limits({ origin })).json).limits as RecordingLimitsDTO,
  transcribe: async (origin, at, wav) => JSON.parse((await L4Share.transcribe({ origin, at, wav: toBase64(wav) })).json).segments as RecordingSaid[],
  send: (origin, marks) => L4Share.sendMarked({ origin, contentType: marks.contentType, body: toBase64(marks.body) }),
  cancel: () => L4Share.cancelShare(),
  leave(origin) { window.location.assign(origin ? `${origin}/projects/board` : 'index.html#servers') },
})

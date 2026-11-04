import { invoke } from '@tauri-apps/api/core'
import { mountMarker, toBase64 } from '../../../packages/native-shell/mark'
import type { RecordingLimitsDTO, RecordingSaid } from '../../../shared/task-recordings'

void mountMarker({
  async share() {
    const pending = await invoke<{ name: string; origin: string | null; servers: { origin: string; name: string }[] } | null>('pending_share')
    if (!pending) return null
    const bytes = await invoke<ArrayBuffer>('shared_file_bytes')
    return { file: new File([bytes], pending.name, { type: /\.(?:mov|mp4|m4v)$/iu.test(pending.name) ? 'video/mp4' : /\.webm$/iu.test(pending.name) ? 'video/webm' : '' }), servers: pending.servers, origin: pending.origin }
  },
  limits: async origin => (JSON.parse(await invoke<string>('recording_limits', { origin })) as { limits: RecordingLimitsDTO }).limits,
  transcribe: async (origin, at, wav) => (JSON.parse(await invoke<string>('transcribe', { origin, at, wav: toBase64(wav) })) as { segments: RecordingSaid[] }).segments,
  send: (origin, marks) => invoke('send_marked', { origin, contentType: marks.contentType, body: toBase64(marks.body) }),
  cancel: () => invoke('cancel_share'),
  leave(origin) {
    if (!origin) return window.location.assign('index.html#servers')
    // Native notifications are granted to this Server's origin only.
    void invoke('allow_server', { origin }).finally(() => window.location.assign(`${origin}/projects/board`))
  },
})

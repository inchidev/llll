import { selectAudioRecordingMime } from '../../shared/audio'
import type { RecordingClip, RecordingLimitsDTO, RecordingSaid } from '../../shared/task-recordings'
import { formatRecordingTime, makeFrames, type Box } from '../../app/utils/recording-frames'
import { audioChunks, clipsFromSpeech } from '../../app/utils/recording-voice'

// The apps' marking page. It lives in the app, so a shared file opens here at once and nothing reaches
// a Server until Save, when the app takes over and sends it in the background. It matches the Client's
// `RecordingMarker.vue`, without Vue or Nuxt UI, so the gestures and words there are the ones to keep.
export type MarkServer = { origin: string; name: string }
export type MarkBridge = {
  /** The file waiting to be marked, the Servers it can go to, and the one used last. */
  share: () => Promise<{ file: File; servers: MarkServer[]; origin: string | null } | null>
  limits: (origin: string) => Promise<RecordingLimitsDTO>
  transcribe: (origin: string, at: number, wav: Uint8Array) => Promise<RecordingSaid[]>
  /** Hands the file and these marks to the app to send. Answers as soon as it has them. */
  send: (origin: string, marks: { body: Uint8Array; contentType: string }) => Promise<void>
  cancel: () => Promise<void>
  /** Leaves this page: to a Server's board once sent, or to the Server list. */
  leave: (origin: string | null) => void
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export async function mountMarker(bridge: MarkBridge) {
  const saveButton = $<HTMLButtonElement>('save'), cancelButton = $<HTMLButtonElement>('cancel'), serverSelect = $<HTMLSelectElement>('server')
  const commentInput = $<HTMLTextAreaElement>('comment'), micButton = $<HTMLButtonElement>('mic'), addButton = $<HTMLButtonElement>('add')
  const clipsRow = $('clips'), note = $('note'), stage = $('stage'), mediaFrame = $('media'), boxView = $('box'), tip = $('tip')
  const resetZoom = $<HTMLButtonElement>('reset-zoom'), clearBox = $<HTMLButtonElement>('clear-box')
  const videoControls = $('video-controls'), playButton = $<HTMLButtonElement>('play'), track = $('track'), selectionView = $('selection'), head = $('head'), timeLabel = $('time')
  const inButton = $<HTMLButtonElement>('in'), outButton = $<HTMLButtonElement>('out'), drawButton = $<HTMLButtonElement>('draw'), hearButton = $<HTMLButtonElement>('hear')

  const say = (text: string, error = false) => { note.textContent = text; note.classList.toggle('error', error) }
  const problem = (cause: unknown) => cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'That did not work.'

  cancelButton.addEventListener('click', () => { void bridge.cancel().finally(() => bridge.leave(null)) })
  const shared = await bridge.share().catch(() => null)
  if (!shared) return bridge.leave(null)
  const { file, servers } = shared
  if (!servers.length) {
    say('Open a Server in L4 and sign in first. Then you can send this.', true)
    $('server-row').hidden = true
  }
  serverSelect.replaceChildren(...servers.map((server) => {
    const option = document.createElement('option')
    option.value = server.origin
    option.textContent = server.name
    return option
  }))
  serverSelect.value = shared.origin && servers.some(server => server.origin === shared.origin) ? shared.origin : servers[0]?.origin ?? ''
  if (servers.length < 2) $('server-row').hidden = true

  const isImage = file.type.startsWith('image/') || !/\.(?:mov|mp4|m4v|webm)$/iu.test(file.name)
  const source = URL.createObjectURL(file)
  let video: HTMLVideoElement | null = null, image: HTMLImageElement | null = null
  let aspect = 9 / 16, ready = false, drawing = false, duration = 0, current = 0, sending = false
  let start: number | null = null, end: number | null = null, box: Box | null = null
  const clips: RecordingClip[] = []
  let transcript: RecordingSaid[] = []

  function refresh() {
    const hasDraft = start !== null || end !== null || box !== null || commentInput.value.trim() !== ''
    addButton.disabled = !hasDraft || sending
    saveButton.disabled = !ready || sending || Boolean(recorder) || !servers.length
    cancelButton.disabled = sending
    boxView.hidden = !box
    if (box) Object.assign(boxView.style, { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`, borderWidth: `${3 / zoom.scale}px` })
    tip.hidden = !boxMode() || Boolean(box) || !ready
    clearBox.hidden = !box
    resetZoom.hidden = zoom.scale <= 1.01
    drawButton.classList.toggle('active', drawing)
    inButton.classList.toggle('active', start !== null)
    outButton.classList.toggle('active', end !== null)
    mediaFrame.style.transform = `translate(-50%, -50%) translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`
    commentInput.style.height = 'auto'
    commentInput.style.height = `${commentInput.scrollHeight + 2}px`
    const range = selection()
    selectionView.hidden = !range
    if (range) Object.assign(selectionView.style, { left: pct(range.start), width: pct(range.end - range.start) })
    head.style.left = pct(current)
    timeLabel.textContent = formatRecordingTime(current)
  }
  const pct = (t: number) => `${(duration ? t / duration : 0) * 100}%`
  const now = () => video?.currentTime ?? 0
  const boxMode = () => isImage || drawing
  const selection = () => {
    if (start === null && end === null) return null
    const a = start ?? end!, b = end ?? start!
    return { start: Math.min(a, b), end: Math.max(a, b) }
  }

  function layout() {
    const w = stage.clientWidth, h = stage.clientHeight
    if (!w || !h) return
    const width = Math.min(w, h * aspect)
    mediaFrame.style.width = `${width}px`
    mediaFrame.style.height = `${width / aspect}px`
  }
  new ResizeObserver(layout).observe(stage)

  if (isImage) {
    image = document.createElement('img')
    image.alt = 'The shared screenshot'
    image.draggable = false
    image.onload = () => {
      if (image!.naturalWidth && image!.naturalHeight) aspect = image!.naturalWidth / image!.naturalHeight
      ready = true
      layout()
      refresh()
    }
    image.onerror = () => say('This picture could not be shown here.', true)
    image.src = source
    mediaFrame.prepend(image)
  }
  else {
    videoControls.hidden = false
    video = document.createElement('video')
    video.playsInline = true
    video.muted = true
    video.preload = 'auto'
    video.onloadedmetadata = () => {
      duration = video!.duration
      if (video!.videoWidth && video!.videoHeight) aspect = video!.videoWidth / video!.videoHeight
      // iOS shows a black box until playback has started once; a muted play and pause draws the first frame.
      if (video!.paused && video!.currentTime === 0) video!.play().then(() => { video!.pause(); video!.currentTime = 0 }).catch(() => {})
      ready = true
      layout()
      refresh()
    }
    video.ontimeupdate = video.onseeked = () => { current = video!.currentTime; refresh() }
    video.onplay = () => { playButton.textContent = '❚❚' }
    video.onpause = () => { playButton.textContent = '▶' }
    video.onerror = () => say('This video could not be played here.', true)
    video.src = source
    mediaFrame.prepend(video)
  }

  const togglePlay = () => { if (video) { if (video.paused) void video.play().catch(() => {}); else video.pause() } }
  playButton.addEventListener('click', togglePlay)
  inButton.addEventListener('click', () => { start = now(); refresh() })
  outButton.addEventListener('click', () => { end = now(); refresh() })
  drawButton.addEventListener('click', () => { drawing = !drawing; refresh() })
  clearBox.addEventListener('click', () => { box = null; refresh() })
  resetZoom.addEventListener('click', () => { zoom = { scale: 1, x: 0, y: 0 }; refresh() })
  commentInput.addEventListener('input', refresh)

  function scrub(event: PointerEvent) {
    if (event.type === 'pointermove' && !(event.buttons & 1)) return
    if (event.type === 'pointerdown') track.setPointerCapture(event.pointerId)
    const rect = track.getBoundingClientRect()
    video!.pause()
    video!.currentTime = current = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration
    refresh()
  }
  track.addEventListener('pointerdown', scrub)
  track.addEventListener('pointermove', scrub)

  // One finger draws the box (or plays and pauses a video), two fingers pinch and pan the picture.
  let zoom = { scale: 1, x: 0, y: 0 }
  const pointers = new Map<number, { x: number; y: number }>()
  let pinch: { distance: number; mid: { x: number; y: number }; start: typeof zoom } | null = null
  let origin: { x: number; y: number } | null = null, boxBefore: Box | null = null, tapTimer: ReturnType<typeof setTimeout> | null = null
  const point = (event: PointerEvent) => {
    const rect = mediaFrame.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) }
  }
  const pinchState = () => {
    const [a, b] = [...pointers.values()]
    return { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } }
  }
  stage.addEventListener('pointerdown', (event) => {
    if (!ready || (event.target as HTMLElement).closest('button')) return
    commentInput.blur()
    stage.setPointerCapture(event.pointerId)
    // The first finger down starts a new gesture; iOS does not always deliver every pointerup.
    if (event.isPrimary) { pointers.clear(); pinch = null; origin = null }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 2) {
      if (origin) { box = boxBefore; origin = null }
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null }
      pinch = { ...pinchState(), start: { ...zoom } }
      return refresh()
    }
    if (pointers.size > 2) return
    if (!boxMode()) { tapTimer = setTimeout(() => { tapTimer = null }, 250); return }
    video?.pause()
    boxBefore = box
    origin = point(event)
    box = { ...origin, w: 0, h: 0 }
    refresh()
  })
  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pinch && pointers.size === 2) {
      const { distance, mid } = pinchState()
      const scale = Math.min(6, Math.max(1, pinch.start.scale * (distance / pinch.distance)))
      zoom = scale === 1 ? { scale: 1, x: 0, y: 0 } : { scale, x: pinch.start.x + mid.x - pinch.mid.x, y: pinch.start.y + mid.y - pinch.mid.y }
      return refresh()
    }
    if (!origin) return
    const p = point(event)
    box = { x: Math.min(origin.x, p.x), y: Math.min(origin.y, p.y), w: Math.abs(p.x - origin.x), h: Math.abs(p.y - origin.y) }
    refresh()
  })
  const stageUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId)
    if (pinch) { if (pointers.size === 0) pinch = null; return }
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; togglePlay() }
    if (!origin) return
    origin = null
    // A sliver is almost always a finger that slipped, not a mark.
    if (box && (box.w < 0.04 || box.h < 0.04)) box = boxBefore
    else drawing = false
    refresh()
  }
  stage.addEventListener('pointerup', stageUp)
  stage.addEventListener('pointercancel', stageUp)

  function addClip() {
    if (addButton.disabled) return
    const range = selection() ?? { start: now(), end: now() }
    clips.push({ start: range.start, end: range.end, box, comment: commentInput.value.trim() })
    clips.sort((a, b) => a.start - b.start)
    start = end = box = null
    commentInput.value = ''
    drawClips()
    refresh()
  }
  addButton.addEventListener('click', addClip)
  function drawClips() {
    clipsRow.replaceChildren(...clips.map((clip, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      const number = document.createElement('b'), label = document.createElement('span'), remove = document.createElement('i')
      number.textContent = String(index + 1)
      label.textContent = clip.comment || (isImage ? 'Box' : formatRecordingTime(clip.start))
      remove.textContent = '✕'
      remove.addEventListener('click', (event) => { event.stopPropagation(); clips.splice(index, 1); drawClips() })
      button.append(number, label, remove)
      button.addEventListener('click', () => {
        addClip()
        const position = clips.indexOf(clip)
        if (position < 0) return
        clips.splice(position, 1)
        start = isImage ? null : clip.start
        end = isImage ? null : clip.end
        box = clip.box
        commentInput.value = clip.comment
        if (video) video.currentTime = clip.start
        drawClips()
        refresh()
      })
      return button
    }))
    track.querySelectorAll('.clip').forEach(element => element.remove())
    for (const clip of clips) {
      const mark = document.createElement('div')
      mark.className = 'clip'
      Object.assign(mark.style, { left: pct(clip.start), width: pct(clip.end - clip.start) })
      track.prepend(mark)
    }
  }

  // Voice: only where this Server can transcribe. Changing Server asks again.
  async function checkVoice() {
    const voice = serverSelect.value ? await bridge.limits(serverSelect.value).then(limits => limits.voice).catch(() => false) : false
    micButton.hidden = !voice
    hearButton.hidden = !voice || isImage
  }
  serverSelect.addEventListener('change', () => { void checkVoice() })
  void checkVoice()

  async function hear(chunks: { at: number; wav: Blob }[]) {
    const said: RecordingSaid[] = []
    for (const [index, chunk] of chunks.entries()) {
      say(chunks.length > 1 ? `Listening ${index + 1}/${chunks.length}…` : 'Listening…')
      said.push(...await bridge.transcribe(serverSelect.value, chunk.at, new Uint8Array(await chunk.wav.arrayBuffer())))
    }
    return said
  }

  // The microphone: spoken words go into the comment, timed from this moment of the recording.
  let recorder: MediaRecorder | null = null
  micButton.addEventListener('click', async () => {
    if (recorder) return recorder.stop()
    say('')
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { return say('The microphone is not available here. Allow it in Settings, or type the comment.', true) }
    const parts: Blob[] = []
    const mimeType = selectAudioRecordingMime(type => MediaRecorder.isTypeSupported(type))
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const startedAt = now()
    micButton.classList.add('active')
    commentInput.placeholder = 'Listening…'
    refresh()
    recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data) }
    recorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop())
      recorder = null
      micButton.classList.remove('active')
      micButton.disabled = true
      commentInput.placeholder = 'What’s wrong here?'
      refresh()
      try {
        const chunks = await audioChunks(await new Blob(parts).arrayBuffer())
        if (!chunks?.length) return say('Nothing that sounded like words.')
        const said = (await hear(chunks)).map(phrase => ({ ...phrase, start: startedAt + phrase.start, end: startedAt + phrase.end }))
        transcript.push(...said)
        commentInput.value = [commentInput.value.trim(), ...said.map(phrase => phrase.text)].filter(Boolean).join(' ')
        say(said.length ? '' : 'Nothing that sounded like words.')
      }
      catch (cause) { say(problem(cause), true) }
      finally { micButton.disabled = false; refresh() }
    }
    recorder.start()
  })

  // The recording's own sound: what was said while recording becomes clips the person can still edit.
  hearButton.addEventListener('click', async () => {
    hearButton.disabled = true
    say('Reading the sound…')
    try {
      const chunks = await audioChunks(await file.arrayBuffer())
      if (!chunks?.length) return say('No voice in this recording. Next time, turn the microphone on when you start recording the screen.')
      const said = await hear(chunks)
      transcript = said
      const fresh = clipsFromSpeech(said).filter(clip => !clips.some(existing => Math.abs(existing.start - clip.start) < 0.5))
      clips.push(...fresh)
      clips.sort((a, b) => a.start - b.start)
      drawClips()
      say(!said.length ? 'Nothing that sounded like words.' : fresh.length ? `${fresh.length} clip${fresh.length === 1 ? '' : 's'} from what you said. Tap one to fix the words or add a box.` : 'Your marks already cover those moments. What you said goes to the agent too.')
    }
    catch (cause) { say(problem(cause), true) }
    finally { hearButton.disabled = false }
  })

  saveButton.addEventListener('click', async () => {
    addClip()
    sending = true
    refresh()
    say('Making frames…')
    try {
      if (video) {
        // iOS only decodes frames after a user gesture has started playback once.
        await video.play().catch(() => {})
        video.pause()
      }
      const frames = await makeFrames(video ?? image!, clips, '', (done, total) => say(`Making frames ${done}/${total}`))
      const form = new FormData()
      form.append('marks', JSON.stringify({ duration: video ? video.duration : null, clips, transcript }))
      form.append('frames', JSON.stringify(frames.map(frame => ({ clip: frame.clip, t: frame.t, zoom: frame.zoom }))))
      for (const frame of frames) form.append('frame', frame.blob, frame.name)
      const encoded = new Response(form)
      const origin = serverSelect.value
      await bridge.send(origin, { body: new Uint8Array(await encoded.arrayBuffer()), contentType: encoded.headers.get('content-type')! })
      URL.revokeObjectURL(source)
      bridge.leave(origin)
    }
    catch (cause) {
      sending = false
      say(problem(cause), true)
      refresh()
    }
  })
  refresh()
}

export function toBase64(bytes: Uint8Array) {
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}

import { RECORDING_MAX_FRAMES, type RecordingClip } from '~~/shared/task-recordings'

// Turns marked clips into the JPEGs the agent reads: each frame with the box drawn on it and the
// user's words in a caption band underneath, never over the picture. Runs in the browser on the
// already-loaded <video> (or <img> for a screenshot), so the server never decodes anything.

export type Clip = RecordingClip
export type Box = NonNullable<Clip['box']>
export interface RecordingFrame { name: string; clip: number; t: number; zoom: boolean; blob: Blob }

const LONG_SIDE = 1200
const ORANGE = '#ff6933'

/** Frame times for a clip: every ~0.5 s, 2 to 8 frames, ends included; one frame for a single moment. */
export function clipTimes(clip: Clip): number[] {
  const length = clip.end - clip.start
  if (length < 0.05) return [clip.start]
  const count = Math.min(8, Math.max(2, Math.ceil(length / 0.5) + 1))
  return Array.from({ length: count }, (_, i) => clip.start + (length * i) / (count - 1))
}

/** Frame times when nothing was marked: ten evenly spaced moments. */
export function wholeTimes(duration: number): number[] {
  return Array.from({ length: 10 }, (_, i) => (duration * (i + 0.5)) / 10)
}

export function formatRecordingTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, '0')}`
}

export type Source = HTMLVideoElement | HTMLImageElement

export async function makeFrames(
  source: Source,
  clips: Clip[],
  note: string,
  onProgress: (done: number, total: number) => void,
): Promise<RecordingFrame[]> {
  type Job = { name: string; clip: number; t: number; zoom: boolean; header: string; text: string; box: Box | null }
  const jobs: Job[] = []
  if (source instanceof HTMLImageElement) {
    // A screenshot: one frame per mark (or the whole picture), plus close-ups of the boxes.
    const marks = clips.length ? clips : [{ start: 0, end: 0, box: null, comment: note }]
    marks.forEach((clip, c) => {
      const label = marks.length > 1 ? `Screenshot · mark ${c + 1}/${marks.length}` : 'Screenshot'
      jobs.push({ name: `s${c + 1}.jpg`, clip: clips.length ? c + 1 : 0, t: 0, zoom: false, box: clip.box, header: label, text: clip.comment })
      if (clip.box) jobs.push({ name: `s${c + 1}-zoom.jpg`, clip: c + 1, t: 0, zoom: true, box: clip.box, header: `${label} · close-up of the box`, text: clip.comment })
    })
  } else if (clips.length === 0) {
    const video = source
    const times = wholeTimes(video.duration)
    times.forEach((t, i) => jobs.push({
      name: `w-${pad(i + 1)}.jpg`, clip: 0, t, zoom: false, box: null,
      header: `Whole recording · ${formatRecordingTime(t)} · frame ${i + 1}/${times.length}`, text: note,
    }))
  }
  if (source instanceof HTMLVideoElement) clips.forEach((clip, c) => {
    const times = clipTimes(clip)
    const label = `Clip ${c + 1}/${clips.length}`
    times.forEach((t, i) => jobs.push({
      name: `c${c + 1}-${pad(i + 1)}.jpg`, clip: c + 1, t, zoom: false, box: clip.box,
      header: `${label} · ${formatRecordingTime(t)} · frame ${i + 1}/${times.length} of ${formatRecordingTime(clip.start)}–${formatRecordingTime(clip.end)}`,
      text: clip.comment,
    }))
    if (clip.box) {
      const t = times[Math.floor((times.length - 1) / 2)]!
      jobs.push({ name: `c${c + 1}-zoom.jpg`, clip: c + 1, t, zoom: true, box: clip.box, header: `${label} · ${formatRecordingTime(t)} · close-up of the box`, text: clip.comment })
    }
  })

  const out: RecordingFrame[] = []
  for (const job of jobs.slice(0, RECORDING_MAX_FRAMES)) {
    if (source instanceof HTMLVideoElement) await seek(source, job.t)
    const blob = await compose(source, job.zoom ? job.box : null, job.zoom ? null : job.box, job.header, job.text)
    out.push({ name: job.name, clip: job.clip, t: job.t, zoom: job.zoom, blob })
    onProgress(out.length, Math.min(jobs.length, RECORDING_MAX_FRAMES))
  }
  return out
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

async function seek(video: HTMLVideoElement, t: number): Promise<void> {
  const target = Math.min(Math.max(0, t), Math.max(0, video.duration - 0.05))
  if (Math.abs(video.currentTime - target) > 0.001) {
    await new Promise<void>((resolve) => {
      const done = () => { video.removeEventListener('seeked', done); resolve() }
      video.addEventListener('seeked', done)
      video.currentTime = target
      setTimeout(done, 3000)
    })
  }
  // Safari can report "seeked" before the new frame is decoded.
  if ('requestVideoFrameCallback' in video) {
    await new Promise<void>((resolve) => {
      video.requestVideoFrameCallback(() => resolve())
      setTimeout(resolve, 250)
    })
  }
}

/** crop: draw only this region, enlarged. mark: draw the full frame with this box outlined. */
async function compose(source: Source, crop: Box | null, mark: Box | null, header: string, text: string): Promise<Blob> {
  const vw = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth
  const vh = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight
  const sx = crop ? crop.x * vw : 0
  const sy = crop ? crop.y * vh : 0
  const sw = crop ? Math.max(1, crop.w * vw) : vw
  const sh = crop ? Math.max(1, crop.h * vh) : vh
  const scale = Math.min(crop ? 3 : 1, LONG_SIDE / Math.max(sw, sh))
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  const width = Math.max(w, 480)

  const font = Math.max(16, Math.round(width * 0.032))
  const padding = Math.round(font * 0.8)
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = `600 ${font}px system-ui, sans-serif`
  const headerLines = wrap(measure, header, width - padding * 2)
  measure.font = `${font}px system-ui, sans-serif`
  const textLines = text.trim() ? wrap(measure, `“${text.trim()}”`, width - padding * 2).slice(0, 10) : []
  const lineHeight = Math.round(font * 1.35)
  const band = padding * 2 + lineHeight * (headerLines.length + textLines.length)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = h + band
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#111114'
  ctx.fillRect(0, 0, width, canvas.height)
  const dx = Math.round((width - w) / 2)
  ctx.drawImage(source, sx, sy, sw, sh, dx, 0, w, h)

  if (mark) {
    const bx = dx + mark.x * w, by = mark.y * h, bw = mark.w * w, bh = mark.h * h
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fillRect(dx, 0, w, by)
    ctx.fillRect(dx, by + bh, w, h - by - bh)
    ctx.fillRect(dx, by, bx - dx, bh)
    ctx.fillRect(bx + bw, by, dx + w - bx - bw, bh)
    ctx.strokeStyle = ORANGE
    ctx.lineWidth = Math.max(3, Math.round(width * 0.006))
    ctx.strokeRect(bx, by, bw, bh)
  }
  if (crop) {
    ctx.strokeStyle = ORANGE
    ctx.lineWidth = Math.max(3, Math.round(width * 0.006))
    ctx.strokeRect(dx, 0, w, h)
  }

  ctx.fillStyle = ORANGE
  ctx.fillRect(0, h, width, 3)
  ctx.textBaseline = 'top'
  let y = h + padding
  ctx.font = `600 ${font}px system-ui, sans-serif`
  ctx.fillStyle = '#f4f4f5'
  for (const line of headerLines) { ctx.fillText(line, padding, y); y += lineHeight }
  ctx.font = `${font}px system-ui, sans-serif`
  ctx.fillStyle = '#fdba8c'
  for (const line of textLines) { ctx.fillText(line, padding, y); y += lineHeight }

  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode a frame')), 'image/jpeg', 0.82))
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (ctx.measureText(next).width > max && line) { lines.push(line); line = word } else line = next
    }
    lines.push(line)
  }
  return lines
}

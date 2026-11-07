import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const TRANSCRIPT_BYTES = 2_000_000

/**
 * Restores the conversation the Server handed over, which holds what was said under the same identity
 * and authority. Without one the session starts fresh: Pi never resumes context the Server did not give.
 */
export async function restoreSession(directory, transcript) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!transcript) { await rm(join(directory, 'session-path'), { force: true }); return }
  const restored = join(directory, 'restored.jsonl')
  await writeFile(restored, transcript, { mode: 0o600 })
  await writeFile(join(directory, 'session-path'), restored, { mode: 0o600 })
}

/** Pi's saved session for the archive step, or null. Only a path inside the session directory is read. */
export async function savedTranscript(directory) {
  try {
    const file = (await readFile(join(directory, 'session-path'), 'utf8')).trim()
    if (!file.startsWith(directory + '/')) throw new Error('Invalid session path')
    const transcript = await readFile(file, 'utf8')
    if (Buffer.byteLength(transcript) > TRANSCRIPT_BYTES) throw new Error('Transcript too large')
    return transcript
  } catch { return null }
}

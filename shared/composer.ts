export type ComposerSubmission<T> = {
  draft: string
  files: T[]
  replyToId: string | null
}

type ComposerSubmissionSource<T> = {
  read: () => ComposerSubmission<T>
  clear: () => void
}

export function claimComposerSubmission<T>(source: ComposerSubmissionSource<T>): ComposerSubmission<T> | null {
  const submission = source.read()
  if (!submission.draft.trim() && !submission.files.length) return null
  const claimed = { ...submission, files: [...submission.files] }
  source.clear()
  return claimed
}

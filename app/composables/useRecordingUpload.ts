import { ref } from 'vue'

/** Sends a recording as the raw request body, with progress. Returns the attachment it became. */
export function useRecordingUpload() {
  const { serverUrl } = useApi()
  const progress = ref(0)

  function upload(taskId: string, file: File) {
    return new Promise<{ id: string }>((resolve, reject) => {
      const request = new XMLHttpRequest()
      request.open('POST', serverUrl(`/api/tasks/${taskId}/recording?name=${encodeURIComponent(file.name)}`))
      request.withCredentials = true
      request.setRequestHeader('Content-Type', 'application/octet-stream')
      request.upload.onprogress = (event) => { if (event.lengthComputable) progress.value = event.loaded / event.total }
      request.onerror = () => reject(new Error('The upload stopped. Check your connection and try again.'))
      request.onload = () => {
        let body: { attachment?: { id: string }; error?: { message?: string } } = {}
        try { body = JSON.parse(request.responseText) }
        catch { /* A proxy's error page: the status is all there is. */ }
        if (request.status < 400 && body.attachment) resolve(body.attachment)
        else reject(new Error(body.error?.message || (request.status === 413 ? 'That file is too large.' : 'The upload did not work.')))
      }
      request.send(file)
    })
  }

  return { upload, progress }
}

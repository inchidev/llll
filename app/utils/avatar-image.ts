import { MAX_AVATAR_BYTES } from '~~/shared/avatar'

export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const AVATAR_SIZE = 512

/** Largest centered square inside a `width` × `height` image. */
export function centerSquare(width: number, height: number) {
  const size = Math.min(width, height)
  return { x: Math.floor((width - size) / 2), y: Math.floor((height - size) / 2), size }
}

/**
 * Crops a picked image to a centered square no larger than 512px so every avatar renders the same
 * in round frames. GIFs pass through untouched to keep animation.
 */
export async function prepareAvatarImage(file: File): Promise<Blob> {
  if (!AVATAR_ACCEPT.split(',').includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP, or GIF image')
  if (file.type === 'image/gif') {
    if (file.size > MAX_AVATAR_BYTES) throw new Error('Animated avatars must be 2 MB or smaller')
    return file
  }
  const bitmap = await createImageBitmap(file)
  try {
    const crop = centerSquare(bitmap.width, bitmap.height)
    const size = Math.min(crop.size, AVATAR_SIZE)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image editing is unavailable in this browser')
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.9))
      ?? await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not process that image')
    if (blob.size > MAX_AVATAR_BYTES) throw new Error('Avatar must be 2 MB or smaller')
    return blob
  }
  finally {
    bitmap.close()
  }
}

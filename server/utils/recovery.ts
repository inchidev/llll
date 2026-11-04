export async function recoveryDigest(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

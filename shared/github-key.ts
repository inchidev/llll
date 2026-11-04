/** GitHub downloads PKCS#1 keys; WebCrypto uses the same RSA key inside a PKCS#8 wrapper. */
export function githubPkcs8(pem: string): string {
  if (!pem.includes('BEGIN RSA PRIVATE KEY')) return pem
  const binary = atob(pem.replace(/-----[^-]+-----|\s/gu, ''))
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const der = (tag: number, value: number[]) => {
    let length = value.length
    const encoded = []
    do { encoded.unshift(length & 255); length >>>= 8 } while (length)
    return [tag, ...(value.length < 128 ? [value.length] : [128 | encoded.length, ...encoded]), ...value]
  }
  const wrapped = der(48, [2, 1, 0, 48, 13, 6, 9, 42, 134, 72, 134, 247, 13, 1, 1, 1, 5, 0, ...der(4, [...bytes])])
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...wrapped)).match(/.{1,64}/gu)!.join('\n')}\n-----END PRIVATE KEY-----`
}

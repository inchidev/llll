declare module '#nitro-internal-pollyfills' {}

declare module '*.sql?raw' {
  const sql: string
  export default sql
}

declare module '#nitro-internal-virtual/public-assets' {
  export function isPublicAssetURL(path: string): boolean
}

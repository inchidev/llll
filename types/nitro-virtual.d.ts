declare module '#nitro-internal-pollyfills' {}

declare module '#nitro-internal-virtual/public-assets' {
  export function isPublicAssetURL(path: string): boolean
}

declare module 'nitropack/runtime' {
  export function useNitroApp(): {
    localFetch: (path: string, init: Record<string, unknown>) => Promise<Response>
  }
}

/**
 * `users.avatar_r2_key` holds either an uploaded object key in `FILES` or, for accounts created
 * through a social provider, the provider's picture URL. Only uploaded keys are served; remote
 * pictures stay unused because the app's image policy is same-origin.
 */
export function isStoredAvatarKey(key: string | null | undefined): key is string {
  return Boolean(key) && !/^[a-z][a-z0-9+.-]*:/i.test(key!)
}

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

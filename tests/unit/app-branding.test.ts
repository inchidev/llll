import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_NAME,
  DEFAULT_APP_SUBTITLE,
  DEFAULT_APP_TITLE,
  NEUTRAL_APP_SUBTITLE,
  readAppBranding,
} from '../../shared/app-branding'

describe('readAppBranding', () => {
  it('uses the product constants; the Server name lives in D1', () => {
    expect(readAppBranding()).toEqual({
      appName: DEFAULT_APP_NAME,
      appTitle: DEFAULT_APP_TITLE,
      appSubtitle: DEFAULT_APP_SUBTITLE,
    })
  })

  it('uses neutral login copy when the runtime is not Cloudflare', () => {
    expect(readAppBranding({ LLLL_RUNTIME: 'celld' }).appSubtitle).toBe(NEUTRAL_APP_SUBTITLE)
    expect(readAppBranding({ LLLL_RUNTIME: 'cloudflare' }).appSubtitle).toBe(DEFAULT_APP_SUBTITLE)
  })
})

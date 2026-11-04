import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner'
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { mountServerList } from '../../../packages/native-shell/server-list'
import { L4Share } from './share-plugin'

const android = Capacitor.getPlatform() === 'android'
/** The oldest browser the Client's build supports. */
const MIN_ANDROID_WEBVIEW = 111
const ServerBridge = registerPlugin<{ allow: (options: { origin: string }) => Promise<void> }>('ServerBridge')

mountServerList({
  readDiscovery: url => CapacitorHttp.get({ url, headers: { Accept: 'application/json' }, connectTimeout: 7000, readTimeout: 7000 }),
  beforeOpen: android
    ? async (origin) => {
        // A Client's code needs a current WebView, which on an old phone may never have updated. It would load as a black page.
        const version = Number(/Chrome\/(\d+)/u.exec(navigator.userAgent)?.[1] ?? 0)
        if (version < MIN_ANDROID_WEBVIEW) throw new Error(`Update Android System WebView in Google Play. This phone has version ${version}, and L4 needs ${MIN_ANDROID_WEBVIEW} or newer.`)
        // Android grants its native bridge to this Server's origin only.
        await ServerBridge.allow({ origin })
      }
    : undefined,
  onServersChanged: (servers) => { void L4Share.syncServers({ servers }).catch(() => undefined) },
  takePendingUrl: async () => (await L4Share.takePendingEditor()).url ?? null,
  scanCode: async () => {
    const { ScanResult } = await CapacitorBarcodeScanner.scanBarcode({ hint: CapacitorBarcodeScannerTypeHint.QR_CODE, scanInstructions: 'Point at the code in Connections on your Server' })
    return ScanResult || null
  },
})

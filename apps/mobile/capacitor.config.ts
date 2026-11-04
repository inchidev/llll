import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'gg.llll.app',
  appName: 'L4',
  webDir: 'www',
  backgroundColor: '#000000',
  server: {
    // Each Server's own Client opens at the Server's operator-chosen origin.
    // Android allows only the Servers on the device, through ServerBridgePlugin.
    allowNavigation: process.argv.includes('android') ? [] : ['*'],
  },
  ios: {
    contentInset: 'never',
    preferredContentMode: 'mobile',
  },
  plugins: {
    LocalNotifications: {
      presentationOptions: ['badge', 'sound', 'banner', 'list'],
    },
  },
}

export default config

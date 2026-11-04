# L4 clients

Source-available clients for L4 servers.

The iOS and macOS apps bundle only a device-local Server list and open
each Server's own Client from that Server. Login, sessions and the Client version
all belong to the Server, and an entry in the list grants no membership. The
Client's Server menu shows **All Servers**, which opens the app's own list. A rail
beside the page, in its own WebView at the app's address, shows the same list; a
Server's page cannot read it. The Chrome extension packages the frontend built from this
monorepo's root Nuxt app.

## Repository

```text
apps/
  mobile/                 Capacitor iOS shell and native bridge
    ios/                  iOS Xcode project
  desktop/                Tauri shell for macOS
  extension/              Chrome Manifest V3 side-panel shell
packages/
  native-shell/           Server list page shared by the native apps
scripts/
  prepare-clients.mjs     Builds and copies the shared frontend (extension)
  generate-brand.mjs      Generates web and native app icons
```

Each native app injects a small bridge into the Client of a Server it opens. The
Client finds `window.__LLLL_NATIVE_NOTIFICATIONS__` and uses it instead of Web
Push, which an app's WebView does not offer. Remote push is not part of these
packages, so these local notifications need the app's page to be running: iOS
suspends a backgrounded app within seconds.

## Requirements

- The Node.js version in the repository `.node-version` file
- The pnpm version in the root `package.json#packageManager` field
- iOS: macOS with Xcode 26 or newer
- macOS app: Rust 1.88 or newer
- Chrome 114 or newer for the extension side panel

Capacitor 8 uses Swift Package Manager by default, so CocoaPods is not required.

## Development

```bash
pnpm install
pnpm --filter @llll/mobile typecheck
pnpm --filter @llll/desktop typecheck
pnpm --filter @llll/extension typecheck
```

## iOS

Adding a Server checks its `/.well-known/llll` discovery document. A launch
reopens the last Server; **All Servers** in the Server menu returns to the list. The injected bridge (`apps/mobile/src/native-bridge.ts`) provides local
notifications, the app badge and opening `target="_blank"` links in Safari View
Controller.

Build the shell and synchronize it into the native project:

```bash
pnpm ios:sync
```

### Simulator

No Apple Account is needed for the Simulator. Open the project with
`pnpm ios:open`, pick an iPhone simulator and press Run. A local Server from
`pnpm dev:stack` is reachable from the Simulator at `http://localhost:<port>`.

### Your own iPhone without Apple Developer Program

A free Apple Account can install the app on your own devices:

1. `pnpm ios:open`, select the `App` target, open **Signing & Capabilities**
   and choose your Apple Account's Personal Team. Change the bundle identifier
   (for example `gg.llll.app.<you>`) if Xcode reports it is taken.
2. Connect the iPhone, enable **Developer Mode** on it when iOS asks, select it
   as the run destination and press Run.
3. On first launch, trust the developer profile in **Settings → General → VPN &
   Device Management**.

Free provisioning has limits: the installed build stops launching after seven
days until you run it from Xcode again, a device holds at most three such apps,
and the Push Notifications capability is unavailable. Without push, a closed or
backgrounded app gets no message notifications; iOS suspends it within seconds
of leaving the screen. For background
notifications without a paid membership, add the Server to the Home Screen
from Safari and enable Web Push there.

Distribution to other people (TestFlight or the App Store) and remote push
through APNs require Apple Developer Program membership and are not set up.

## macOS

The macOS app uses the same Server list and opens each Server in its window. The
**Servers** button in the title bar returns to the list. Only the list can grant
an origin the bridge's permissions (`allow_server` in
`apps/desktop/src-tauri/src/lib.rs`), for the current run; any other page has no
native access.

Build and launch a development app:

```bash
pnpm macos:dev
```

Build the `.app` and `.dmg` bundles:

```bash
pnpm macos:build
```

The bundles are under `apps/desktop/src-tauri/target/release/bundle`. They are
ad-hoc signed: on another Mac, open the app the first time with Control-click →
**Open** or allow it in **System Settings → Privacy & Security**. Signed and
notarized downloads require Apple Developer Program membership and are not set
up. A notification's click does not open its Channel, because Tauri's desktop
notification plugin reports no click action.

## Sharing a screenshot or recording

Neither app needs the iPhone Shortcut. A file shared to L4 becomes a Task through
the device key path (`/api/recordings`), on any Server with Record a bug:

- **Key:** when a listed Server's Client opens signed in, the injected bridge
  makes a device key for the Space on screen (`packages/native-shell/recording-key.ts`).
  It only sends recordings, and it shows under Settings → Connections, where it can be turned off.
  It stays on the device through sign-out; removing the Server from the list forgets it on
  the device but does not turn it off on the Server.
- **Marking:** `packages/native-shell/mark.html` is the apps' own marking page, so a shared
  file opens at once with no Server involved. It matches the Client's `RecordingMarker.vue`.
  Save cuts the frames and hands everything to the app, which sends it in the background:
  the file first, which makes the Task, then its marks and frames as one request. Voice
  goes through the Server by the same key. If sending fails, a notification says so.
- **iOS:** the `ShareExtension` target appears in the system share sheet. It hands the
  file over and opens the app, through the responder chain because iOS has no call for
  it. If the app won't open, the sheet sends the file itself, and marking waits for later.
  The app and the extension share an App Group and a Keychain group, both named
  `group.$(L4_BUNDLE_ID)`. A free Apple Account works, but its builds last 7 days. To
  build with one, set `L4_BUNDLE_ID` and your team, then in Xcode tick that group under
  Signing & Capabilities for both targets once, since `xcodebuild` can't register it.
- **macOS:** a file reaches the marking page from the Dock, Open With, or the Share menu.
  The extension in `apps/desktop/share-extension` is sandboxed and holds no key: it copies
  the file into its own container and opens `llll://share`. Keys are in a `0600` file in
  the app's data folder. macOS keeps a new Share menu extension off until the person turns
  it on under Edit Extensions in that menu; the Dock and Open With need nothing.

## Chrome extension

The extension packages the same generated L4 frontend and opens it in
Chrome's side panel. It keeps the client server rail and asks for access only to
each L4 server the user connects.

Build the unpacked extension:

```bash
pnpm extension:build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked**, and select `apps/extension/www`. Clicking the L4 toolbar
icon opens the side panel. The extension currently provides the shared chat
client shell and does not request password-manager or page-control permissions.

## License

[Elastic License 2.0](../LICENSE)

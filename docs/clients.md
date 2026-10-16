# L4 clients

Open-source native clients for L4 installations.

The native applications package the frontend built from this monorepo's root
Nuxt app. A connected L4 installation
is the remote backend; remote servers do not provide executable UI to the app.

## Repository

```text
apps/
  mobile/                 Capacitor shell
    ios/                  Generated native Xcode project
  desktop/                Tauri shell for macOS
  extension/              Chrome Manifest V3 side-panel shell
scripts/
  prepare-clients.mjs     Builds and copies the shared frontend
```

The shared frontend has web, native, and extension runtime modes. Web
deployments keep same-origin API and WebSocket URLs. Bundled clients store a
server list on-device and route API, WebSocket, attachment, workspace-icon,
invite, and email-session traffic through the selected server.

The packaged shells bridge realtime message activity to platform notifications
after the user enables them in L4 settings. Notifications carry the
sender, message preview, unread badge, and an internal route back to the
Channel. These local notifications cover an active or briefly backgrounded
native client. Remote push delivery is not part of these client packages.

## Requirements

- The Node.js version in the repository `.node-version` file
- The pnpm version in the root `package.json#packageManager` field
- macOS with Xcode 26 or newer
- Rust 1.88 or newer for macOS desktop builds
- Chrome 114 or newer for the extension side panel

Capacitor 8 uses Swift Package Manager by default, so CocoaPods is not required.

## Development

```bash
pnpm install
pnpm --filter @llll/mobile typecheck
pnpm --filter @llll/desktop typecheck
pnpm --filter @llll/extension typecheck
```

The root app owns native and extension runtime modes. `pnpm prepare:clients`
generates the shared SPA once per target and copies it into each shell.

## iOS

Build the root app in native SPA mode, copy its `.output/public` artifact,
and synchronize it into the native project:

```bash
pnpm ios:sync
```

Open the project in Xcode:

```bash
pnpm ios:open
```

In Xcode, select the `App` target, open **Signing & Capabilities**, choose your
Apple Account team, and make the bundle identifier unique if Xcode asks. Connect
your iPhone, select it as the run destination, then press Run.

For local development on your own iPhone, a free Apple Account is sufficient;
the development provisioning profile expires after seven days. TestFlight is
for distributing builds to other testers and requires Apple Developer Program
membership.

## macOS

The desktop client uses Tauri and the same generated native SPA as iOS. Tauri's
Rust HTTP client supplies cross-origin networking and a persistent cookie jar;
WebSockets still connect directly to the selected L4 server. External
links open in the default browser.

Build and launch a development app:

```bash
pnpm macos:dev
```

Build the `.app` and `.dmg` bundles:

```bash
pnpm macos:build
```

Unsigned local builds use an ad-hoc signature. For distribution, provide a
Developer ID Application identity through `APPLE_SIGNING_IDENTITY` and the
Apple notarization environment variables documented by Tauri. The generated
artifacts are under `apps/desktop/src-tauri/target/release/bundle`.

### GitHub Releases

Pushing a `desktop-v*` tag matching the desktop package version builds a universal
macOS app and publishes its `.app` and `.dmg` bundles on this repository's
GitHub Release without triggering a workspace product release:

```bash
git tag desktop-v0.0.1
git push origin desktop-v0.0.1
```

The workflow builds the bundled frontend from the same commit as the native shell.

The publish workflow requires
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` as GitHub Actions secrets.
It fails before publishing when signing or notarization credentials are absent;
local builds remain ad-hoc signed.

GitHub Release delivery is configured. Published builds are installed
explicitly; the client does not perform automatic update checks.

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

MIT
